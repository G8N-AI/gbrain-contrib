import type { SinkPatterns } from './ts.ts';

/**
 * Ruby / Rails sink patterns, matched against Ruby call-edge names
 * (edge-extractor.ts RubyScope): `A::B.m` for a constant receiver, `A::B#m`
 * for an instance it constructs, `A::B` for `A::B.new`, and a bare `m` for an
 * untyped receiver (`connection.execute`). Backticks and `%x()` emit an edge
 * named `` ` `` (Kernel#`).
 *
 * Only names are visible here, never arguments: `where` with a string
 * fragment and `File.open` with a write mode cannot be told from their safe
 * forms, so `where` is not listed and file reads count as file_io, as they
 * do for TypeScript and Python.
 */
export const RB_SINKS: SinkPatterns = {
  http_call: ['Net::HTTP', 'Net::HTTP.*', 'Net::HTTP#*', 'Net::HTTP::*', 'Faraday', 'Faraday.*', 'Faraday#*', 'HTTParty.*'],
  db_call: [
    'find_by_sql', '*.find_by_sql', 'count_by_sql', '*.count_by_sql',
    'execute', '*.execute', 'exec_query', '*.exec_query', 'exec_insert', 'exec_update', 'exec_delete',
    'select_all', 'select_one', 'select_value', 'select_values', 'select_rows',
  ],
  file_io: [
    'File', 'File.open', 'File.read', 'File.write', 'File.readlines', 'File.foreach', 'File.binread', 'File.binwrite',
    'File.delete', 'File.unlink', 'File.rename', 'FileUtils.*', 'IO.read', 'IO.readlines', 'IO.write', 'IO.binread',
    'IO.binwrite', 'Pathname#read', 'Pathname#write', 'Pathname#binread', 'Pathname#binwrite',
  ],
  process_exec: [
    '`', 'system', 'Kernel.system', 'spawn', 'Kernel.spawn', 'Process.spawn', 'exec', 'Kernel.exec', 'Open3.*', 'IO.popen',
  ],
} as const;
