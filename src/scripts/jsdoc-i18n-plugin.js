/**
 * @file JSDoc i18n post-processing plugin.
 *
 * Source comments are written in **English only** (the canonical language); no
 * translations live in the source. To produce a localised documentation set,
 * run JSDoc with `DOC_LANG=<lang>` and provide a translation file at
 * `docs-i18n/<lang>.json` (or point `DOC_I18N_FILE` at one). The file is keyed
 * by doclet `longname`; matching `description` / `classdesc` / `returns` /
 * `params` / `properties` text is swapped in at doc-generation time. Missing
 * keys fall back to the original English, so partial translations are fine.
 *
 * @module scripts/jsdoc-i18n-plugin
 */

'use strict';

const fs = require('fs');
const path = require('path');

const lang = process.env.DOC_LANG || 'en';

let dict = {};
if (lang !== 'en') {
    const file =
        process.env.DOC_I18N_FILE ||
        path.resolve(__dirname, '..', 'docs-i18n', `${lang}.json`);
    try {
        dict = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.error(`[jsdoc-i18n] could not read ${file}: ${err.message}`);
    }
}

exports.handlers = {
    newDoclet(e) {
        if (lang === 'en') return;

        const doclet = e.doclet;
        const t = doclet && dict[doclet.longname];
        if (!t) return;

        if (typeof t.description === 'string') doclet.description = t.description;
        if (typeof t.classdesc === 'string') doclet.classdesc = t.classdesc;

        if (typeof t.returns === 'string' && Array.isArray(doclet.returns)) {
            doclet.returns.forEach((r) => {
                r.description = t.returns;
            });
        }

        if (t.params && Array.isArray(doclet.params)) {
            doclet.params.forEach((p) => {
                if (t.params[p.name] != null) p.description = t.params[p.name];
            });
        }

        if (t.properties && Array.isArray(doclet.properties)) {
            doclet.properties.forEach((p) => {
                if (t.properties[p.name] != null) {
                    p.description = t.properties[p.name];
                }
            });
        }
    },
};
