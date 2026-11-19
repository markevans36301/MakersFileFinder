// This file runs in Node.js and reads the local filesystem.
// index.html runs in the browser and asks this server for data over HTTP.
// To trace a search, start at the /api/search route near the bottom.
'use strict';
// require() loads modules. The node: prefix means they come with Node.js.
const http = require('node:http'),
    fs = require('node:fs'),
    p = require('node:path'),
    {
        spawn,
        execFile
    } = require('node:child_process');
const version = '2026-11-08.3';
const port = 43127,
    token = require('node:crypto').randomBytes(24).toString('hex'),
    config = p.join(__dirname, 'folders.json');
// roots holds selected folders. files holds their searchable metadata in memory.
let roots = [],
    files = [],
    busy = false,
    skipped = 0,
    cloudLocations = new Set(),
    scanned = 0,
    catalogReady = false,
    cachedAt = null,
    catalogNotice = '',
    retained = 0,
    creationDatesIndexed = false;
const cachePath = p.join(__dirname, 'catalog-cache.json');
try
{
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (Array.isArray(saved)) roots = saved.filter(x => typeof x === 'string' && p.isAbsolute(x));
}
catch
{}
// Use a normalized path as the key so overlapping roots do not list a file twice.
function pathKey(value)
{
    const resolved = p.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function insideRoot(file, root)
{
    const key = pathKey(file),
        base = pathKey(root);
    return key === base || key.startsWith(base.endsWith(p.sep) ? base : base + p.sep);
}

function rememberCloud(full, set)
{
    const match = full.match(/^(.*?[\\/](?:Dropbox|OneDrive(?: - [^\\/]+)?))[\\/]/i);
    if (match) set.add(match[1]);
}
// Validate the saved metadata before making it the active catalog.
function loadCatalog()
{
    try
    {
        const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (saved.schema !== 1 || JSON.stringify(saved.roots) !== JSON.stringify(roots) || !Array.isArray(saved.files) || !Number.isFinite(saved.savedAt)) return;
        const seen = new Set(),
            loaded = [];
        for (const file of saved.files)
        {
            if (!file || !['name', 'path', 'folder', 'ext'].every(key => typeof file[key] === 'string') || !p.isAbsolute(file.path) || p.dirname(file.path) !== file.folder || p.basename(file.path) !== file.name || !roots.some(root => insideRoot(file.path, root)) || !(file.size === null || Number.isFinite(file.size) && file.size >= 0) || !(file.modified === null || Number.isFinite(file.modified))) throw Error('Invalid catalog entry');
            const key = pathKey(file.path);
            if (seen.has(key)) continue;
            seen.add(key);
            loaded.push(
            {
                ...file,
                type: category(file.ext),
                created: Number.isFinite(file.created) && file.created > 0 ? file.created : null
            });
        }
        files = loaded;
        catalogReady = true;
        creationDatesIndexed = saved.creationDatesIndexed === true;
        cachedAt = saved.savedAt;
        retained = Number.isSafeInteger(saved.retained) ? Math.max(0, saved.retained) : 0;
        for (const file of files) rememberCloud(file.path, cloudLocations);
    }
    catch (e)
    {
        if (e.code !== 'ENOENT') catalogNotice = 'Saved catalog could not be loaded; rebuilding it.';
    }
}
// Reuse a valid saved catalog until the user requests a refresh.
loadCatalog();
// Write to a temporary file, then rename it into place after the write succeeds.
async function saveCatalog()
{
    const savedAt = Date.now();
    try
    {
        await fs.promises.writeFile(cachePath + '.tmp', JSON.stringify(
        {
            schema: 1,
            roots,
            savedAt,
            retained,
            creationDatesIndexed,
            files
        }));
        await fs.promises.rename(cachePath + '.tmp', cachePath);
        cachedAt = savedAt;
        catalogNotice = '';
    }
    catch
    {
        catalogNotice = 'Search works, but the catalog could not be saved for next time.';
    }
}
// Preferences use a separate file. A promise chain queues writes one at a time.
const preferencesPath = p.join(__dirname, 'saved-searches.json');
const starterSearches = [
{
    name: 'CNC files',
    q: '*.nc OR *.tap OR *.gcode'
},
{
    name: '3D printing',
    q: '*.stl OR *.3mf'
},
{
    name: 'Fusion projects',
    q: '*.f3d OR *.f3z'
}].map(s => (
{
    ...s,
    scope: '',
    depth: 'all',
    exclude: '',
    type: 'All'
}));
let preferences = {
        searches: starterSearches,
        favorites: []
    },
    preferenceWrite = Promise.resolve();
try
{
    preferences = validatePreferences(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')));
}
catch (e)
{
    if (e.code !== 'ENOENT') console.error('Saved searches could not be loaded:', e.message);
}
// Interpret the date picker in the PC's local time. The end is the next
// midnight, which includes the entire selected To day even across DST.
function creationDateRange(from = '', to = '')
{
    function localDay(value)
    {
        if (value === '') return null;
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Enter dates in YYYY-MM-DD format.');
        const date = new Date(value + 'T00:00:00');
        const [year, month, day] = value.split('-').map(Number);
        if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) throw Error('Enter a valid calendar date.');
        return date;
    }
    const first = localDay(from),
        last = localDay(to);
    if (first && last && first > last) throw Error('The From date must be on or before the To date.');
    if (last)
    {
        last.setDate(last.getDate() + 1);
        last.setHours(0, 0, 0, 0);
    }
    return {
        start: first?.getTime() ?? -Infinity,
        end: last?.getTime() ?? Infinity,
        active: !!(first || last)
    };
}
// Check saved data and edits from the browser before using either.
function validatePreferences(value)
{
    if (!value || !Array.isArray(value.searches) || !Array.isArray(value.favorites) || value.searches.length > 100 || value.favorites.length > 100) throw Error('Choose up to 100 saved searches and 100 favorites.');
    const text = (v, max) =>
    {
        if (typeof v !== 'string' || v.length > max) throw Error('Invalid saved search text.');
        return v;
    };
    const names = new Set();
    const searches = value.searches.map(s =>
    {
        const name = text(s.name, 100).trim();
        if (!name || names.has(name.toLowerCase())) throw Error('Use a unique name for each saved search.');
        names.add(name.toLowerCase());
        const q = text(s.q, 2048),
            exclude = text(s.exclude, 2048),
            scope = text(s.scope, 4096);
        compileQuery(q);
        if (exclude.trim()) compileQuery(exclude);
        if (!['all', 'only'].includes(s.depth) || !['All', 'Projects', 'Documents', 'Pictures', 'Other'].includes(s.type)) throw Error('Invalid saved search options.');
        const sort = s.sort || 'name',
            order = s.order || 'asc';
        if (!['name', 'modified', 'size', 'ext'].includes(sort) || !['asc', 'desc'].includes(order)) throw Error('Invalid saved sort options.');
        const
        {
            createdFrom = '', createdTo = ''
        } = s;
        creationDateRange(createdFrom, createdTo);
        return {
            name,
            q,
            exclude,
            scope,
            depth: s.depth,
            type: s.type,
            sort,
            order,
            ...(createdFrom ?
            {
                createdFrom
            } :
            {}),
            ...(createdTo ?
            {
                createdTo
            } :
            {})
        };
    });
    const favorites = value.favorites.map(f =>
    {
        const scope = text(f.scope, 4096).trim();
        if (!scope || !['all', 'only'].includes(f.depth)) throw Error('Enter a folder before saving a favorite.');
        return {
            scope,
            depth: f.depth
        };
    });
    return {
        searches,
        favorites
    };
}
// A Set gives the scanner a quick way to recognize directories it should skip.
const ignore = new Set(['node_modules', '.git', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)', '$RECYCLE.BIN', 'System Volume Information']);
// The file-type buttons use this fixed extension mapping. The plain-language
// CAD group in index.html uses a separate, broader extension list.
function category(ext)
{
    return /^(f3d|f3z|step|stp|stl|3mf|crv|crv3d|svg|dxf|obj|gcode|gco|cnc|ngc|ncc|nc|tap|scad|plt|hpgl)$/.test(ext) ? 'Projects' : /^(pdf|docx?|xlsx?|pptx?|txt|md|csv|rtf)$/.test(ext) ? 'Documents' : /^(png|jpe?g|gif|webp|heic|bmp|tiff?|avif|ico|apng|jfif)$/.test(ext) ? 'Pictures' : 'Other';
}
// Normalize punctuation and capitalization. ElectronicsBox becomes electronics box.
function clueWords(value)
{
    return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
}
// Words search paths; wildcard patterns match whole filenames, or whole paths
// when the pattern contains a path separator. Quotes preserve literal phrases.
function compileQuery(query)
{
    if (query.length > 2048) throw Error('Keep your search under 2,048 characters.');
    // Step 1. Split input into tokens such as operators, parentheses and terms.
    // Quoted text stays together as one term even if it contains spaces.
    const tokens = [];
    let i = 0;
    while (i < query.length)
    {
        if (/\s/.test(query[i]))
        {
            i++;
            continue;
        }
        const c = query[i];
        if ('()!'.includes(c))
        {
            tokens.push(
            {
                kind: c === '!' ? 'NOT' : c
            });
            i++;
            continue;
        }
        // Recognize a field prefix followed immediately by a quote. The ?. skips
        // the match-group lookup when the regular expression finds no prefix.
        const field = /^(clue|name):"/i.exec(query.slice(i, i + 6))?.[1].toLowerCase();
        if (field) i += 5;
        let value = '',
            quoted = false;
        while (i < query.length && !/\s/.test(query[i]) && !'()!'.includes(query[i]))
        {
            if (query[i] === '"')
            {
                quoted = true;
                i++;
                let closed = false;
                while (i < query.length)
                {
                    if (query[i] === '"')
                    {
                        i++;
                        closed = true;
                        break;
                    }
                    value += query[i++];
                }
                if (!closed) throw Error('Close the quotation mark in your search.');
            }
            else value += query[i++];
        }
        if (!value) throw Error('Enter some text inside quotation marks.');
        const upper = value.toUpperCase();
        tokens.push(
        {
            kind: !quoted && ['AND', 'OR', 'NOT'].includes(upper) ? upper : 'TERM',
            value,
            field
        });
        if (tokens.length > 256) throw Error('Too many search terms.');
    }
    // Step 2. Build a tree of conditions. atom handles NOT and parentheses,
    // and() handles AND (including spaces), and or() handles OR.
    let at = 0,
        depth = 0;
    const peek = () => tokens[at]?.kind;

    function atom()
    {
        if (++depth > 64) throw Error('Too many nested search conditions.');
        let node;
        if (peek() === 'NOT')
        {
            at++;
            node = {
                op: 'NOT',
                child: atom()
            };
        }
        else if (peek() === '(')
        {
            at++;
            node = or();
            if (peek() !== ')') throw Error('Add a closing parenthesis.');
            at++;
        }
        else if (peek() === 'TERM')
        {
            const term = tokens[at++];
            node = {
                op: 'TERM',
                value: term.value,
                field: term.field
            };
        }
        else throw Error('Expected a word, quoted phrase, or condition after an operator.');
        depth--;
        return node;
    }

    function and()
    {
        let node = atom();
        while (peek() === 'AND' || ['TERM', '(', 'NOT'].includes(peek()))
        {
            if (peek() === 'AND') at++;
            node = {
                op: 'AND',
                left: node,
                right: atom()
            };
        }
        return node;
    }

    function or()
    {
        let node = and();
        while (peek() === 'OR')
        {
            at++;
            node = {
                op: 'OR',
                left: node,
                right: and()
            };
        }
        return node;
    }
    if (!tokens.length)
    {
        const all = () => true;
        all.description = 'All files';
        return all;
    }
    const tree = or();
    if (at !== tokens.length) throw Error('Unexpected closing parenthesis or operator.');
    // Step 3. Turn each condition into a function that returns true or false
    // for a file. The => syntax defines a function. For example,
    // f => f.ext === 'svg' returns true only for SVG files.
    function build(n)
    {
        if (n.op === 'TERM')
        {
            // Compare whole normalized words or phrases in the filename and in each
            // parent folder separately. Padding with spaces enforces the word boundaries.
            if (n.field === 'clue')
            {
                const clue = clueWords(n.value).trim();
                if (!clue) throw Error('Enter a word or phrase for the project clue.');
                return f => [f.name, ...(f.folder ?? p.dirname(f.path)).split(/[\\/]/)].some(value => (' ' + clueWords(value) + ' ').includes(' ' + clue + ' '));
            }
            const term = n.value.toLowerCase();
            // includes() finds literal text anywhere in the filename, including its extension.
            if (n.field === 'name') return f => f.name.toLowerCase().includes(term);
            if (!term.includes('*')) return f => f.path.toLowerCase().includes(term);
            // Convert * to a pattern for any number of characters. Escape other
            // regex characters so they retain their literal meaning.
            const re = new RegExp('^' + term.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') + '$', 'i');
            return f => re.test(/[\\/]/.test(term) ? f.path : f.name);
        }
        if (n.op === 'NOT')
        {
            const child = build(n.child);
            return f => !child(f);
        }
        const left = build(n.left),
            right = build(n.right);
        return n.op === 'AND' ? f => left(f) && right(f) : f => left(f) || right(f);
    }
    // Build the human-readable interpretation separately from the file matcher.
    function describe(n)
    {
        if (n.op === 'TERM') return (n.field === 'clue' ? 'Project clue ' : n.field === 'name' ? 'Filename contains ' : '') + JSON.stringify(n.value);
        if (n.op === 'NOT') return '(NOT ' + describe(n.child) + ')';
        return '(' + describe(n.left) + ' ' + n.op + ' ' + describe(n.right) + ')';
    }
    const matcher = build(tree);
    matcher.description = describe(tree);
    return matcher;
}
// Compare folder components, so "3d print" never matches "3d printer".
function inScope(file, scope, depth = 'all')
{
    scope = scope.trim().replace(/^"|"$/g, '');
    if (!scope) return true;
    const normalize = value => value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
    const folder = normalize(file.folder ?? p.dirname(file.path)),
        wanted = normalize(scope);
    const absolute = /^(?:[a-z]:|\/)/i.test(wanted);
    if (absolute) return folder === wanted || (depth !== 'only' && folder.startsWith(wanted + '/'));
    const parts = folder.split('/'),
        target = wanted.split('/');
    for (let i = 0; i <= parts.length - target.length; i++)
    {
        if (target.every((part, j) => part === parts[i + j]) && (depth !== 'only' || i + target.length === parts.length)) return true;
    }
    return false;
}
// sort() uses this comparator to order pairs of files. A negative result
// puts the first file earlier. Name and path break ties.
function compareFiles(sort = 'name', order = 'asc')
{
    const direction = order === 'desc' ? -1 : 1;
    const text = (a, b) => a.localeCompare(b, undefined,
    {
        numeric: true,
        sensitivity: 'base'
    });
    return (a, b) =>
    {
        const x = a[sort],
            y = b[sort];
        let result;
        if (x == null || y == null)
        {
            if (x == null && y != null) return 1;
            if (y == null && x != null) return -1;
            result = 0;
        }
        else result = (sort === 'size' || sort === 'modified') ? x - y : text(x, y);
        return direction * result || text(a.name, b.name) || text(a.path, b.path) || a.path.localeCompare(b.path);
    };
}
// await lets the server handle other requests during filesystem waits.
// Refreshes build a replacement catalog while searches use the previous one.
async function scan()
{
    if (busy) return;
    busy = true;
    scanned = 0;
    skipped = 0;
    retained = 0;
    const baseline = files,
        nextFiles = [],
        nextCloud = new Set(),
        failedDirs = new Set(),
        seen = new Set();
    if (!catalogReady) files = nextFiles;
    try
    {
        for (const root of roots)
        {
            const stack = [root];
            while (stack.length)
            {
                const dir = stack.pop();
                let entries;
                try
                {
                    entries = await fs.promises.readdir(dir,
                    {
                        withFileTypes: true
                    });
                }
                catch
                {
                    skipped++;
                    failedDirs.add(pathKey(dir));
                    continue;
                }
                // Limit simultaneous metadata requests, especially on cloud and network drives.
                for (let offset = 0; offset < entries.length; offset += 32) await Promise.all(entries.slice(offset, offset + 32).map(async e =>
                {
                    const full = p.join(dir, e.name),
                        key = pathKey(full);
                    if (full === cachePath || full === cachePath + '.tmp') return;
                    if (seen.has(key)) return;
                    seen.add(key);
                    if (e.isSymbolicLink())
                    {
                        skipped++;
                        return;
                    }
                    if (e.isDirectory())
                    {
                        if (!ignore.has(e.name)) stack.push(full);
                        return;
                    }
                    if (!e.isFile()) return;
                    let size = null,
                        modified = null,
                        created = null;
                    try
                    {
                        const info = await fs.promises.lstat(full);
                        if (info.isSymbolicLink())
                        {
                            skipped++;
                            return;
                        }
                        size = info.size;
                        modified = info.mtimeMs;
                        created = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : null;
                    }
                    catch
                    {}
                    const ext = p.extname(e.name).slice(1).toLowerCase();
                    nextFiles.push(
                    {
                        name: e.name,
                        path: full,
                        folder: dir,
                        ext,
                        type: category(ext),
                        size,
                        modified,
                        created
                    });
                    scanned = nextFiles.length;
                    rememberCloud(full, nextCloud);
                }));
            }
        }
        // If a directory could not be read, keep its previous entries. A successful
        // directory read can tell us that a file is no longer present.
        // Keep last-known entries in folders that were temporarily unavailable.
        for (const file of baseline)
        {
            if (seen.has(pathKey(file.path))) continue;
            let dir = file.folder;
            while (true)
            {
                if (failedDirs.has(pathKey(dir)))
                {
                    nextFiles.push(file);
                    rememberCloud(file.path, nextCloud);
                    retained++;
                    break;
                }
                const parent = p.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
        }
        files = nextFiles;
        cloudLocations = nextCloud;
        catalogReady = true;
        creationDatesIndexed = true;
        await saveCatalog();
    }
    catch (e)
    {
        catalogNotice = 'The refresh was interrupted; the previous catalog is still available.';
        if (catalogReady) files = baseline;
        throw e;
    }
    finally
    {
        busy = false;
    }
}
// Preview support is separate from the categories and search groups.
const imageTypes = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jfif: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    apng: 'image/png',
    svg: 'image/svg+xml'
};
const textTypes = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'nc', 'tap', 'gcode', 'gco', 'cnc', 'ngc', 'ncc', 'plt', 'hpgl', 'js', 'cjs', 'mjs', 'py', 'css', 'html', 'htm', 'bat', 'ps1', 'sh', 'scad', 'step', 'stp', 'mtl']);
const packageTypes = new Set(['3mf', 'f3d', 'f3z', 'docx', 'xlsx', 'pptx']);
const inflateRaw = require('node:util').promisify(require('node:zlib').inflateRaw);
// Inspect ZIP members in memory only. Nothing from an archive is executed/extracted to disk.
function zipDirectory(data)
{
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
        if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length)
        {
            end = i;
            break;
        }
    if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw Error('Not a supported ZIP package.');
    const count = data.readUInt16LE(end + 10),
        length = data.readUInt32LE(end + 12),
        offset = data.readUInt32LE(end + 16);
    if (count > 20000 || count === 65535 || offset + length > end) throw Error('Package is too complex for preview.');
    let cursor = offset;
    const entries = [];
    for (let i = 0; i < count; i++)
    {
        if (cursor + 46 > offset + length || data.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid package directory.');
        const nameLength = data.readUInt16LE(cursor + 28),
            extraLength = data.readUInt16LE(cursor + 30),
            commentLength = data.readUInt16LE(cursor + 32),
            next = cursor + 46 + nameLength + extraLength + commentLength;
        if (next > offset + length) throw Error('Invalid package entry.');
        entries.push(
        {
            name: data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
            flags: data.readUInt16LE(cursor + 8),
            method: data.readUInt16LE(cursor + 10),
            compressed: data.readUInt32LE(cursor + 20),
            size: data.readUInt32LE(cursor + 24),
            offset: data.readUInt32LE(cursor + 42)
        });
        cursor = next;
    }
    return entries;
}
// Read only the archive members required by the selected preview format.
async function packagePreview(data, ext)
{
    try
    {
        const entries = zipDirectory(data);
        let expanded = 0;
        async function extract(entry)
        {
            if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 8 * 1024 * 1024 || expanded + entry.size > 16 * 1024 * 1024) throw Error('Package member is encrypted or exceeds preview limits.');
            const at = entry.offset;
            if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50) throw Error('Invalid package data.');
            const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
            if (start + entry.compressed > data.length) throw Error('Invalid package range.');
            const raw = data.subarray(start, start + entry.compressed),
                bytes = entry.method === 0 ? Buffer.from(raw) : await inflateRaw(raw,
                {
                    maxOutputLength: 8 * 1024 * 1024
                });
            if (bytes.length !== entry.size) throw Error('Incomplete package member.');
            expanded += bytes.length;
            return bytes;
        }
        const member = name => entries.find(e => e.name.toLowerCase() === name.toLowerCase());
        if (['docx', 'xlsx', 'pptx'].includes(ext))
        {
            let selected = [];
            if (ext === 'docx') selected = [member('word/document.xml')].filter(Boolean);
            if (ext === 'xlsx') selected = [member('xl/workbook.xml'), member('xl/_rels/workbook.xml.rels'), member('xl/sharedStrings.xml'), ...entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined,
            {
                numeric: true
            })).slice(0, 3)].filter(Boolean);
            if (ext === 'pptx') selected = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined,
            {
                numeric: true
            })).slice(0, 10);
            if (!selected.length) throw Error('Document content not found.');
            const parts = [];
            for (const entry of selected) parts.push(
            {
                name: entry.name,
                text: (await extract(entry)).toString('utf8')
            });
            return {
                kind: 'office',
                format: ext,
                parts
            };
        }
        const candidates = entries.filter(e => /(thumbnail|preview)/i.test(e.name) && /\.(png|jpe?g|webp)$/i.test(e.name) && e.size <= 8 * 1024 * 1024).sort((a, b) => a.name.localeCompare(b.name));
        let thumbnail = null;
        for (const entry of candidates.slice(0, 3))
        {
            try
            {
                thumbnail = {
                    mime: imageTypes[p.extname(entry.name).slice(1).toLowerCase()],
                    data: (await extract(entry)).toString('base64')
                };
                break;
            }
            catch
            {}
        }
        return {
            kind: 'package',
            format: ext,
            thumbnail,
            entries: entries.filter(e => !e.name.endsWith('/')).slice(0, 80).map(e => e.name),
            count: entries.length,
            message: thumbnail ? 'Embedded thumbnail from the saved project. This is not a live 3D render.' : 'No embedded thumbnail found. Project contents are listed below; use Open file to view the design.'
        };
    }
    catch
    {
        return {
            kind: 'unsupported',
            message: 'This package cannot be previewed. It may be damaged, encrypted, or exceed the preview limits. Use Open file.'
        };
    }
}
// Preview reads happen on demand. The server checks the path and size
// before reading. Searching the catalog only uses file metadata.
async function readPreview(file)
{
    const image = Object.hasOwn(imageTypes, file.ext) ? imageTypes[file.ext] : null,
        isPackage = packageTypes.has(file.ext),
        model = ['stl', 'obj'].includes(file.ext),
        drawing = file.ext === 'dxf',
        pdf = file.ext === 'pdf';
    if (!image && !isPackage && !model && !drawing && !pdf && !textTypes.has(file.ext)) return {
        kind: 'unsupported',
        message: /^(crv|crv3d)$/.test(file.ext) ? 'Native VCarve previews are not available yet. Export SVG, DXF or STL for a visual preview, or use Open file.' : 'No preview for this file type yet. Use Open file or Show in folder.'
    };
    let handle;
    try
    {
        const info = await fs.promises.lstat(file.path);
        if (!info.isFile() || info.isSymbolicLink()) throw Error('Not a regular file.');
        const real = await fs.promises.realpath(file.path),
            allowed = await Promise.all(roots.map(root => fs.promises.realpath(root).catch(() => null)));
        if (!allowed.some(root => root && insideRoot(real, root))) throw Error('Outside cataloged folders.');
        const full = !!(image || isPackage || model || drawing || pdf),
            limit = (isPackage || model ? 32 : pdf ? 16 : drawing ? 4 : image ? 8 : 0.25) * 1024 * 1024;
        const oversized = {
            kind: 'unsupported',
            message: 'This file exceeds the ' + (limit / 1024 / 1024) + ' MB limit for this preview. Use Open file.'
        };
        if (full && info.size > limit) return oversized;
        handle = await fs.promises.open(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        if (!(await handle.stat()).isFile()) throw Error('Not a regular file.');
        const buffer = Buffer.alloc(limit + 1);
        let count = 0;
        while (count < buffer.length)
        {
            const
            {
                bytesRead
            } = await handle.read(buffer, count, buffer.length - count, count);
            if (!bytesRead) break;
            count += bytesRead;
        }
        const data = buffer.subarray(0, Math.min(count, limit)),
            truncated = count > limit;
        if (full && truncated) return oversized;
        if (isPackage) return await packagePreview(data, file.ext);
        if (image) return {
            kind: 'image',
            mime: image,
            data: data.toString('base64'),
            label: file.ext === 'svg' ? 'SVG drawing preview' : 'Picture preview'
        };
        if (model) return {
            kind: 'model',
            format: file.ext,
            data: data.toString('base64')
        };
        if (pdf)
        {
            if (data.subarray(0, 5).toString() !== '%PDF-') return {
                kind: 'unsupported',
                message: 'This file does not contain a recognizable PDF header. Use Open file.'
            };
            return {
                kind: 'pdf',
                data: data.toString('base64')
            };
        }
        let text, encoding;
        if (data[0] === 0xff && data[1] === 0xfe)
        {
            encoding = 'UTF-16 LE';
            text = new TextDecoder('utf-16le').decode(data);
        }
        else if (data[0] === 0xfe && data[1] === 0xff)
        {
            encoding = 'UTF-16 BE';
            text = new TextDecoder('utf-16be').decode(data);
        }
        else
        {
            try
            {
                encoding = 'UTF-8';
                text = new TextDecoder('utf-8',
                {
                    fatal: !truncated
                }).decode(data);
            }
            catch
            {
                encoding = 'Windows-1252';
                text = new TextDecoder('windows-1252').decode(data);
            }
        }
        if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) return {
            kind: 'unsupported',
            message: 'This appears to be a binary file. Use Open file to view it.'
        };
        if (drawing) return {
            kind: 'dxf',
            text
        };
        return {
            kind: 'text',
            text,
            encoding,
            truncated,
            label: ['step', 'stp'].includes(file.ext) ? 'STEP source excerpt (no solid-model rendering)' : ''
        };
    }
    catch
    {
        return {
            kind: 'unavailable',
            message: 'Cannot preview this file. It may have moved, be offline, or be unavailable to FileFinder. Refresh the catalog or use Show in folder.'
        };
    }
    finally
    {
        if (handle) await handle.close();
    }
}

function json(res, v, status = 200)
{
    res.writeHead(status,
    {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(v));
}
// Ask Windows for the Desktop path, which may be redirected to OneDrive.
function findDesktop()
{
    const fallback = p.join(require('node:os').homedir(), 'Desktop');
    if (process.platform !== 'win32') return Promise.resolve(fallback);
    const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('DesktopDirectory')";
    return new Promise(resolve =>
    {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        {
            windowsHide: true,
            timeout: 5000
        }, (error, output) =>
        {
            const desktop = error ? '' : output.trim();
            resolve(p.isAbsolute(desktop) ? desktop : fallback);
        });
    });
}


// GET routes read the page or data. POST routes request actions and need
// the local token. Listening on 127.0.0.1 keeps the server local to this PC.
function start()
{
    const desktopPath = findDesktop();
    return http.createServer(async (req, res) =>
    {
        try
        {
            if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) return json(res,
            {
                error: 'Invalid host'
            }, 403);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src blob:; frame-src blob:; frame-ancestors 'none'");
            const url = new URL(req.url, 'http://127.0.0.1:' + port);
            if (req.method === 'GET' && url.pathname === '/')
            {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.end(fs.readFileSync(p.join(__dirname, 'index.html')));
            }
            // Serve only these two bundled images. The URL never becomes an arbitrary file path.
            if (req.method === 'GET' && ['/branding/nikko.svg', '/branding/flying-monkey-patch.png'].includes(url.pathname))
            {
                const artwork = p.join(__dirname, 'branding', p.basename(url.pathname));
                let image;
                try
                {
                    image = await fs.promises.readFile(artwork);
                }
                catch (e)
                {
                    if (e.code === 'ENOENT') return json(res,
                    {
                        error: 'Brand artwork is missing. Copy the branding folder beside index.html.'
                    }, 404);
                    throw e;
                }
                res.setHeader('Content-Type', artwork.endsWith('.png') ? 'image/png' : 'image/svg+xml');
                return res.end(image);
            }
            if (req.method === 'GET' && url.pathname === '/api/preferences') return json(res, preferences);
            if (req.method === 'GET' && url.pathname === '/api/status')
            {
                const desktop = await desktopPath;
                return json(res,
                {
                    token,
                    version,
                    desktop,
                    roots,
                    locations: [...new Set([desktop, ...roots, ...cloudLocations])],
                    busy,
                    count: files.length,
                    skipped,
                    scanned,
                    catalogReady,
                    cachedAt,
                    catalogNotice,
                    retained,
                    creationDatesIndexed
                });
            }
            // Apply every active filter to the in-memory list. The exclusion receives
            // only the filename. Sort all matches before slicing out the requested page.
            if (req.method === 'GET' && url.pathname === '/api/search')
            {
                let matchesQuery, excludeQuery, dates;
                try
                {
                    dates = creationDateRange(url.searchParams.get('createdFrom') ?? '', url.searchParams.get('createdTo') ?? '');
                    matchesQuery = compileQuery(url.searchParams.get('q') || '');
                    const exclude = url.searchParams.get('exclude') || '';
                    excludeQuery = exclude.trim() ? compileQuery(exclude) : null;
                }
                catch (e)
                {
                    return json(res,
                    {
                        error: e.message
                    }, 400);
                }
                const type = url.searchParams.get('type') || 'All',
                    scope = url.searchParams.get('scope') || '';
                const depth = url.searchParams.get('depth') || 'all';
                // Missing timestamps remain searchable when no date range is selected.
                const matches = files.filter(f => (!dates.active || (f.created != null && f.created >= dates.start && f.created < dates.end)) && (type === 'All' || f.type === type) && inScope(f, scope, depth) && matchesQuery(f) && (!excludeQuery || !excludeQuery(
                {
                    name: f.name,
                    path: f.name
                })));
                const sort = url.searchParams.get('sort') || 'name',
                    order = url.searchParams.get('order') || 'asc',
                    limit = Number(url.searchParams.get('limit') || 150),
                    requestedPage = Number(url.searchParams.get('page') || 1);
                if (!['name', 'modified', 'size', 'ext'].includes(sort) || !['asc', 'desc'].includes(order) || ![50, 150, 300].includes(limit) || !Number.isSafeInteger(requestedPage) || requestedPage < 1) return json(res,
                {
                    error: 'Invalid sorting or page options.'
                }, 400);
                matches.sort(compareFiles(sort, order));
                const pages = Math.max(1, Math.ceil(matches.length / limit)),
                    page = Math.min(requestedPage, pages),
                    offset = (page - 1) * limit;
                return json(res,
                {
                    version,
                    interpreted: matchesQuery.description,
                    excluded: excludeQuery?.description || null,
                    total: matches.length,
                    page,
                    pages,
                    limit,
                    sort,
                    order,
                    results: matches.slice(offset, offset + limit)
                });
            }
            // Check the local request token before allowing action routes.
            if (req.method !== 'POST' || req.headers['x-local-token'] !== token) return json(res,
            {
                error: 'Request not allowed'
            }, 403);
            if (req.headers.origin && !['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(req.headers.origin)) return json(res,
            {
                error: 'Invalid origin'
            }, 403);
            let body = '';
            for await (const chunk of req)
            {
                body += chunk;
                if (body.length > 32768) return json(res,
                {
                    error: 'Request too large'
                }, 413);
            }
            const data = JSON.parse(body || '{}');
            if (url.pathname === '/api/preview')
            {
                const file = files.find(f => f.path === data.path);
                if (!file) return json(res,
                {
                    error: 'File is not in the catalog. Refresh the catalog and try again.'
                }, 404);
                return json(res, await readPreview(file));
            }
            if (url.pathname === '/api/preferences')
            {
                let next;
                try
                {
                    next = validatePreferences(data);
                }
                catch (e)
                {
                    return json(res,
                    {
                        error: e.message
                    }, 400);
                }
                const write = preferenceWrite.catch(() =>
                {}).then(async () =>
                {
                    await fs.promises.writeFile(preferencesPath + '.tmp', JSON.stringify(next, null, 2));
                    await fs.promises.rename(preferencesPath + '.tmp', preferencesPath);
                    preferences = next;
                });
                preferenceWrite = write;
                await write;
                return json(res, preferences);
            }
            if (url.pathname === '/api/folders')
            {
                if (busy) return json(res,
                {
                    error: 'Please wait for the scan to finish.'
                }, 409);
                if (!Array.isArray(data.roots) || data.roots.length > 30) return json(res,
                {
                    error: 'Choose up to 30 folders.'
                }, 400);
                const next = [];
                for (const root of data.roots)
                {
                    if (typeof root !== 'string' || !p.isAbsolute(root)) return json(res,
                    {
                        error: 'Enter full folder paths.'
                    }, 400);
                    let s;
                    try
                    {
                        s = await fs.promises.stat(root);
                    }
                    catch
                    {
                        return json(res,
                        {
                            error: 'Cannot access ' + root
                        }, 400);
                    }
                    if (!s.isDirectory()) return json(res,
                    {
                        error: 'Not a folder: ' + root
                    }, 400);
                    next.push(p.resolve(root));
                }
                const updated = [...new Set(next)];
                await fs.promises.writeFile(config, JSON.stringify(updated, null, 2));
                if (JSON.stringify(roots) !== JSON.stringify(updated))
                {
                    files = [];
                    catalogReady = false;
                    cachedAt = null;
                    creationDatesIndexed = false;
                    cloudLocations = new Set();
                }
                roots = updated;
                void scan().catch(console.error);
                return json(res,
                {
                    ok: true
                });
            }
            if (url.pathname === '/api/scan')
            {
                void scan().catch(console.error);
                return json(res,
                {
                    ok: true
                });
            }
            if (url.pathname === '/api/open')
            {
                const file = files.find(f => f.path === data.path);
                if (!file) return json(res,
                {
                    error: 'File is not in the catalog.'
                }, 404);
                const safe = /^(pdf|docx?|xlsx?|pptx?|txt|png|jpe?g|webp|gif|avif|ico|bmp|jfif|apng|tiff?|heic|stl|obj|step|stp|f3d|f3z|3mf|crv|crv3d|scad|csv|md|dxf|svg)$/; // Use the desktop's opener off Windows. For other file types, open the parent
                // folder so the OS does not launch the selected file as a program.
                if (process.platform !== 'win32')
                {
                    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
                    const target = data.folder || !safe.test(file.ext) ? p.dirname(file.path) : file.path;
                    await new Promise((resolve, reject) =>
                    {
                        const child = spawn(command, [target],
                        {
                            stdio: 'ignore'
                        });
                        child.once('error', reject);
                        child.once('exit', code => code === 0 ? resolve() : reject(Error('The desktop could not open this location.')));
                    });
                    return json(res,
                    {
                        ok: true
                    });
                }
                if (data.folder || !safe.test(file.ext))
                {
                    spawn('explorer.exe', ['/select,', file.path],
                    {
                        detached: true,
                        stdio: 'ignore'
                    }).on('error', () =>
                    {}).unref();
                }
                else
                {
                    const command = "Start-Process -FilePath '" + file.path.replace(/'/g, "''") + "'";
                    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                    {
                        windowsHide: true,
                        stdio: 'ignore'
                    }).on('error', () =>
                    {}).unref();
                }
                return json(res,
                {
                    ok: true
                });
            }
            json(res,
            {
                error: 'Not found'
            }, 404);
        }
        catch (e)
        {
            json(res,
            {
                error: e.message
            }, 500);
        }
    }).listen(port, '127.0.0.1', () =>
    {
        console.log('File Finder: http://127.0.0.1:' + port);
        if (roots.length && !catalogReady) void scan().catch(console.error);
    }).on('error', e =>
    {
        console.error(e.message);
        process.exitCode = 1;
    });
}
// Export functions for tests. Running this file directly starts the server.
module.exports = {
    compileQuery,
    inScope,
    category,
    compareFiles,
    zipDirectory,
    packagePreview,
    start
};
if (require.main === module)
{
    const server = start();
    if (process.argv.includes('--open'))
    {
        server.once('listening', () =>
        {
            spawn((
            {
                win32: 'explorer.exe',
                darwin: 'open'
            })[process.platform] || 'xdg-open', ['http://127.0.0.1:' + port],
            {
                detached: true,
                stdio: 'ignore'
            }).on('error', () =>
            {}).unref();
        });
    }
}
