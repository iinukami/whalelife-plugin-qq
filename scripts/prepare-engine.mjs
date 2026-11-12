/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { fileURLToPath } from 'node:url';
import { prepareVendor, parseArchiveArguments } from './vendor-package.mjs';
const result = await prepareVendor(fileURLToPath(new URL('../', import.meta.url)), 'shell', parseArchiveArguments(process.argv.slice(2)));
console.log(`Verified engine ready: ${result.name} ${result.version}, ${result.files} files`);
