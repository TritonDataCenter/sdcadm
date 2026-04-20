/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tap = require('tap');

const testutil = require('../testutil');

const do_get_tritonadm = require('../../../lib/cli/do_get_tritonadm');
const parseVersionFile = do_get_tritonadm._parseVersionFile;
const readInstalledVersion = do_get_tritonadm._readInstalledVersion;
const pickLatest = do_get_tritonadm._pickLatest;
const GetTritonadm = do_get_tritonadm._GetTritonadm;


function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tritonadm-test-'));
}


tap.test('parseVersionFile: all fields', function (t) {
    var content = [
        'uuid=11111111-2222-3333-4444-555555555555',
        'version=master-20260420T120000Z-gabcdef1',
        'installed_at=2026-04-20T12:00:00Z',
        'source=network'
    ].join('\n');
    var parsed = parseVersionFile(content);
    t.equal(parsed.uuid, '11111111-2222-3333-4444-555555555555');
    t.equal(parsed.version, 'master-20260420T120000Z-gabcdef1');
    t.equal(parsed.installed_at, '2026-04-20T12:00:00Z');
    t.equal(parsed.source, 'network');
    t.end();
});


tap.test('parseVersionFile: ignores blank lines and comments', function (t) {
    var content = [
        '# a comment',
        '',
        '   ',
        'uuid=abc',
        '# trailing',
        'source=embedded'
    ].join('\n');
    var parsed = parseVersionFile(content);
    t.equal(parsed.uuid, 'abc');
    t.equal(parsed.source, 'embedded');
    t.notOk(parsed['# a comment']);
    t.end();
});


tap.test('parseVersionFile: values containing =', function (t) {
    var parsed = parseVersionFile('foo=bar=baz');
    t.equal(parsed.foo, 'bar=baz');
    t.end();
});


tap.test('parseVersionFile: trims whitespace', function (t) {
    var parsed = parseVersionFile('  uuid  =  abc  \n');
    t.equal(parsed.uuid, 'abc');
    t.end();
});


tap.test('parseVersionFile: skips lines with no =', function (t) {
    var parsed = parseVersionFile('nothere\nuuid=abc\n');
    t.equal(parsed.uuid, 'abc');
    t.notOk(parsed.nothere);
    t.end();
});


tap.test('readInstalledVersion: happy path', function (t) {
    var dir = tmpdir();
    var filePath = path.join(dir, 'version');
    fs.writeFileSync(filePath,
        'uuid=11111111-2222-3333-4444-555555555555\n' +
        'version=master-20260420T120000Z-gabcdef1\n' +
        'installed_at=2026-04-20T12:00:00Z\n' +
        'source=network\n');
    t.teardown(function () {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
    });
    readInstalledVersion(filePath, function (err, vers) {
        t.error(err);
        t.ok(vers);
        t.equal(vers.uuid, '11111111-2222-3333-4444-555555555555');
        t.equal(vers.source, 'network');
        t.end();
    });
});


tap.test('readInstalledVersion: missing file returns null', function (t) {
    var dir = tmpdir();
    var filePath = path.join(dir, 'version');
    t.teardown(function () { fs.rmdirSync(dir); });
    readInstalledVersion(filePath, function (err, vers) {
        t.error(err);
        t.equal(vers, null);
        t.end();
    });
});


tap.test('readInstalledVersion: file without uuid returns null',
        function (t) {
    var dir = tmpdir();
    var filePath = path.join(dir, 'version');
    fs.writeFileSync(filePath, '# no uuid here\nsource=network\n');
    t.teardown(function () {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
    });
    readInstalledVersion(filePath, function (err, vers) {
        t.error(err);
        t.equal(vers, null);
        t.end();
    });
});


tap.test('pickLatest: empty array', function (t) {
    t.equal(pickLatest([]), undefined);
    t.end();
});


tap.test('pickLatest: sorts descending by published_at', function (t) {
    var a = {uuid: 'a', published_at: '2026-01-01T00:00:00Z'};
    var b = {uuid: 'b', published_at: '2026-04-01T00:00:00Z'};
    var c = {uuid: 'c', published_at: '2026-02-01T00:00:00Z'};
    t.equal(pickLatest([a, b, c]).uuid, 'b');
    t.end();
});


/*
 * When the installed uuid matches the candidate uuid, the engine must
 * not call getImageFile.
 */
tap.test('GetTritonadm: UUID match short-circuits before download',
        function (t) {
    var dir = tmpdir();
    var versionFile = path.join(dir, 'version');
    fs.writeFileSync(versionFile,
        'uuid=11111111-2222-3333-4444-555555555555\n' +
        'version=master-20260420T120000Z-gabcdef1\n');
    t.teardown(function () {
        fs.unlinkSync(versionFile);
        fs.rmdirSync(dir);
    });

    var downloadCalled = false;
    var stubSdcadm = {
        log: testutil.createBunyanLogger(tap),
        config: {updatesServerUrl: 'http://example.invalid'},
        ensureSdcApp: function (_opts, cb) { cb(); },
        acquireLock: function (_opts, cb) {
            cb(null, function unlock(unlockCb) { unlockCb(); });
        },
        releaseLock: function (opts, cb) { opts.unlock(cb); },
        getDefaultChannel: function (cb) { cb(null, 'staging'); },
        updates: {
            listImages: function (_filters, cb) {
                cb(null, [{
                    uuid: '11111111-2222-3333-4444-555555555555',
                    name: 'tritonadm',
                    version: 'master-20260420T120000Z-gabcdef1',
                    published_at: '2026-04-20T12:00:00Z'
                }]);
            },
            getImage: function (_uuid, cb) {
                cb(new Error('getImage should not be called'));
            },
            getImageFile: function (_uuid, _filePath, cb) {
                downloadCalled = true;
                cb(new Error('download should not be called'));
            }
        }
    };

    var messages = [];
    var engine = new GetTritonadm({
        sdcadm: stubSdcadm,
        progress: function () {
            messages.push(require('util').format.apply(null, arguments));
        },
        image: 'latest',
        versionFile: versionFile
    });

    engine.run(function (err) {
        t.error(err);
        t.equal(downloadCalled, false,
            'getImageFile must not be called when UUIDs match');
        t.match(messages.join('\n'), /Already up-to-date/);
        t.end();
    });
});


/*
 * Empty channel: no download, friendly message.
 */
tap.test('GetTritonadm: empty channel reports nothing to install',
        function (t) {
    var dir = tmpdir();
    var versionFile = path.join(dir, 'does-not-exist');
    t.teardown(function () { fs.rmdirSync(dir); });

    var downloadCalled = false;
    var stubSdcadm = {
        log: testutil.createBunyanLogger(tap),
        config: {updatesServerUrl: 'http://example.invalid'},
        ensureSdcApp: function (_opts, cb) { cb(); },
        acquireLock: function (_opts, cb) {
            cb(null, function unlock(unlockCb) { unlockCb(); });
        },
        releaseLock: function (opts, cb) { opts.unlock(cb); },
        getDefaultChannel: function (cb) { cb(null, 'staging'); },
        updates: {
            listImages: function (_filters, cb) { cb(null, []); },
            getImage: function (_uuid, cb) {
                cb(new Error('getImage should not be called'));
            },
            getImageFile: function (_uuid, _filePath, cb) {
                downloadCalled = true;
                cb(new Error('download should not be called'));
            }
        }
    };

    var messages = [];
    var engine = new GetTritonadm({
        sdcadm: stubSdcadm,
        progress: function () {
            messages.push(require('util').format.apply(null, arguments));
        },
        image: 'latest',
        versionFile: versionFile
    });

    engine.run(function (err) {
        t.error(err);
        t.equal(downloadCalled, false);
        t.match(messages.join('\n'), /No tritonadm images available/);
        t.end();
    });
});
