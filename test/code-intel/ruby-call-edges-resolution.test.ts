/**
 * Ruby call edges resolve, on every backend (PGLite always; Postgres when a
 * safe DATABASE_URL is set, and in the E2E lane through
 * test/e2e/code-intel-ruby-postgres.test.ts).
 *
 * Ruby chunks are qualified `A::B#m` / `A::B.m`. Before the extractor named
 * Ruby receivers, every Ruby call edge carried a bare token (`attempt`, `new`,
 * `run`) that never equals a qualified chunk name, so a Rails app resolved 0
 * edges, `code_callers` on a class found nothing, and `code_blast` /
 * `code_flow` refused Ruby as unsupported_language.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../../src/core/chunkers/symbol-resolver.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const HEALTH_CHECK = `module Acme
  class HealthCheck
    def self.run(client:)
      new(client: client).run
    end

    def initialize(client:)
      @client = client
    end

    def run
      attempt { @client.ping }
      record(:ok)
    end

    private

    def attempt
      yield
    end

    def record(status)
      status
    end
  end
end
`;

const PROBE_JOB = `module Acme
  class HealthProbeJob
    def perform(client)
      Acme::HealthCheck.new(client: client).run
    end
  end
end
`;

for (const kind of testBackends()) {
  describe(`Ruby call-edge resolution (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => {
      await close?.();
    });
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'app/%'`);
      await importCodeFile(engine, 'app/services/acme/health_check.rb', HEALTH_CHECK, { noEmbed: true });
      await importCodeFile(engine, 'app/jobs/acme/health_probe_job.rb', PROBE_JOB, { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
    });

    const resolvedCallers = async (symbol: string) =>
      (await engine.getCallersOf(symbol, { sourceId: 'default' })).map((e) => `${e.from_symbol_qualified}${e.resolved ? '' : ' (by name)'}`).sort();

    test('same-file calls resolve to their Ruby chunks', async () => {
      expect(await resolvedCallers('Acme::HealthCheck#attempt')).toEqual(['Acme::HealthCheck#run']);
      expect(await resolvedCallers('Acme::HealthCheck#record')).toEqual(['Acme::HealthCheck#run']);
      // `def self.run` and `def run` are different chunks; `new(...).run` calls the instance one.
      expect(await resolvedCallers('Acme::HealthCheck#run')).toEqual(['Acme::HealthCheck.run', 'Acme::HealthProbeJob#perform (by name)']);
    });

    test('code_callers on a class finds the files that construct it', async () => {
      const op: any = await handleToolCall(engine, 'code_callers', { symbol: 'Acme::HealthCheck' });
      const callers = op.callers.map((e: any) => `${e.from_symbol_qualified}${e.resolved ? '' : ' (by name)'}`).sort();
      expect(callers).toEqual(['Acme::HealthCheck.run', 'Acme::HealthProbeJob#perform (by name)']);
    });

    test('code_blast walks Ruby callers instead of refusing the language', async () => {
      const op: any = await handleToolCall(engine, 'code_blast', { symbol: 'Acme::HealthCheck#attempt' });
      expect(op.result).toBe('ok');
      expect(op.depth_groups.map((g: any) => g.nodes.map((n: any) => n.symbol))).toEqual([
        ['Acme::HealthCheck#run'],
        ['Acme::HealthCheck.run'],
      ]);
    });

    test('code_flow follows a Ruby entry point through resolved hops', async () => {
      const op: any = await handleToolCall(engine, 'code_flow', { entry_point: 'Acme::HealthCheck.run' });
      expect(op.result).toBe('ok');
      const byDepth = op.depth_groups.map((g: any) => g.nodes.map((n: any) => n.symbol).sort());
      expect(byDepth[0]).toEqual(['Acme::HealthCheck', 'Acme::HealthCheck#run']);
      // `@client.ping` has an untyped receiver and stays a bare name.
      expect(byDepth[1]).toEqual(['Acme::HealthCheck#attempt', 'Acme::HealthCheck#record', 'ping']);
    });

    test('two same-file definitions of one method stay ambiguous, not guessed', async () => {
      await importCodeFile(engine, 'app/models/acme/report.rb', `module Acme
  class Report
    def build
      render_row(1)
    end

    def render_row(x); end
  end

  class Report
    def render_row(x); end
  end
end
`, { noEmbed: true });
      const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(stats.edges_ambiguous).toBe(1);
      const [edge] = await engine.getCallersOf('Acme::Report#render_row', { sourceId: 'default' });
      expect(edge?.resolved).toBe(false);
      expect(edge?.edge_metadata.ambiguous).toBe(true);
      expect(edge?.edge_metadata.candidates).toHaveLength(2);
    });
  });
}
