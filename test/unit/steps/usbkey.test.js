/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 */
'use strict';

const fs = require('fs');

const mockfs = require('mock-fs');
const tap = require('tap');

const usbkey = require('../../../lib/steps/usbkey');

const joysetupDir = '/usbkey/extra/joysetup/';

tap.test('removeOldCNToolsTarballs', function (suite) {
    suite.test('empty', function (t) {
        mockfs({[joysetupDir]: {}});
        usbkey.removeOldCNToolsTarballs({}, function () {
            const stats = fs.statSync(joysetupDir);
            t.ok(stats.isDirectory(joysetupDir));
            const files = fs.readdirSync(joysetupDir);
            t.equal(files.length, 0);
            mockfs.restore();
            t.end();
        });
    });

    suite.test('other-files-untouched', function (t) {
        mockfs({[joysetupDir]:
                {'cn_tools.tar.gz': '',
                 'joysetup.sh': '',
                 'agentsetup.sh': '',
                 'cn_tools.20180208T185323.tar.gz': ''}});
        usbkey.removeOldCNToolsTarballs({}, function () {
            const files = fs.readdirSync(joysetupDir);
            t.ok(files.length === 4);
            mockfs.restore();
            t.end();
        });
    });

    suite.test('prune', function (t) {
        const isCNTools = function isCNTools(p) {
            return (p.startsWith('cn_tools.') &&
                    p.endsWith('tar.gz') &&
                    p !== 'cn_tools.tar.gz');
        };
        const oldFormatTools = ['cn_tools.2017-12-14T15:57:59.179Z.tar.gz',
                                'cn_tools.2017-08-31T14:36:03.728Z.tar.gz'];
        const oldTools = ['cn_tools.20180201T000000.tar.gz',
                          'cn_tools.20180201T204654.tar.gz'];
        const cnTools = ['cn_tools.20180207T220522.tar.gz',
                         'cn_tools.20180208T181727.tar.gz',
                         'cn_tools.20180208T181853.tar.gz',
                         'cn_tools.20180208T185323.tar.gz'];
        const stdFiles =
              {'cn_tools.tar.gz': '',
               'joysetup.sh': '',
               'agentsetup.sh': ''};
        const checkRemoved = function checkRemoved(tt) {
            const files = fs.readdirSync(joysetupDir);
            tt.equal(files.length, 7);
            const remainingTools = files.filter(isCNTools);
            const remainingOther = files.filter(function (p) {
                return (!isCNTools(p));
            });
            tt.deepEqual(remainingTools.slice().sort(),
                         cnTools.slice().sort());
            tt.deepEqual(remainingOther.slice().sort(),
                         Object.keys(stdFiles).sort());
            mockfs.restore();
            tt.end();
        };

        t.test('prune-old-tarballs', function (tt) {
            const fakeFiles = Object.assign({}, stdFiles);
            for (let fname of [].concat(cnTools, oldTools)) {
                fakeFiles[fname] = '';
            }
            mockfs({[joysetupDir]: fakeFiles});
            usbkey.removeOldCNToolsTarballs({}, function () {
                checkRemoved(tt);
            });
        });

        t.test('prune-old-format', function (tt) {
            const fakeFiles = Object.assign({}, stdFiles);
            for (let fname of [].concat(cnTools, oldTools, oldFormatTools)) {
                fakeFiles[fname] = '';
            }
            mockfs({[joysetupDir]: fakeFiles});
            usbkey.removeOldCNToolsTarballs({}, function () {
                checkRemoved(tt);
            });
        });

        t.end();
    });

    suite.end();
});
