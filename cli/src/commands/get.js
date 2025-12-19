import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { getEntry, resolveDocPath } from '../lib/registry.js';
import { fetchDoc } from '../lib/cache.js';
import { output, error, info } from '../lib/output.js';

export function registerGetCommand(program) {
  program
    .command('get <id> [language]')
    .description('Retrieve a doc or skill')
    .option('--version <version>', 'Specific version')
    .option('-o, --output <path>', 'Write to file instead of stdout')
    .action(async (id, language, opts) => {
      const globalOpts = program.optsWithGlobals();
      const result = getEntry(id);

      if (result.ambiguous) {
        error(
          `Multiple entries with id "${id}". Be specific:\n  ${result.alternatives.join('\n  ')}`,
          globalOpts
        );
      }

      if (!result.entry) {
        error(`Entry "${id}" not found.`, globalOpts);
      }

      const entry = result.entry;

      // If no language specified and multiple available, show options
      if (!language && entry.languages?.length > 1) {
        error(
          `Multiple languages available: ${entry.languages.map((l) => l.language).join(', ')}. Specify one.`,
          globalOpts
        );
      }

      const resolved = resolveDocPath(entry, language, opts.version);
      if (!resolved) {
        error(`Could not resolve path for ${id} ${language || ''} ${opts.version || ''}`, globalOpts);
      }

      try {
        const content = await fetchDoc(resolved.source, resolved.path);

        if (opts.output) {
          mkdirSync(dirname(opts.output), { recursive: true });
          writeFileSync(opts.output, content);
          info(`Written to ${opts.output}`);
          if (globalOpts.json) {
            console.log(JSON.stringify({ id: entry.id, path: opts.output, size: content.length }));
          }
        } else {
          output(
            { id: entry.id, content, path: resolved.path },
            (data) => process.stdout.write(data.content),
            globalOpts
          );
        }
      } catch (err) {
        error(err.message, globalOpts);
      }
    });
}
