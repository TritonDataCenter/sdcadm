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
const path = require('path');

const mockfs = require('mock-fs');
const tap = require('tap');

const usbkey = require('../../../lib/steps/usbkey');


tap.test('removeOldCNToolsTarballs', function (suite) {
    const joysetupDir = '/usbkey/extra/joysetup/';
    const progress = suite.comment;

    suite.test('empty', function (t) {
        mockfs({[joysetupDir]: {}});
        usbkey.removeOldCNToolsTarballs({progress: progress}, function () {
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
        usbkey.removeOldCNToolsTarballs({progress: progress}, function () {
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
            usbkey.removeOldCNToolsTarballs({progress: progress}, function () {
                checkRemoved(tt);
            });
        });

        t.test('prune-old-format', function (tt) {
            const fakeFiles = Object.assign({}, stdFiles);
            for (let fname of [].concat(cnTools, oldTools, oldFormatTools)) {
                fakeFiles[fname] = '';
            }
            mockfs({[joysetupDir]: fakeFiles});
            usbkey.removeOldCNToolsTarballs({progress: progress}, function () {
                checkRemoved(tt);
            });
        });

        t.end();
    });

    suite.end();
});


tap.test('removeOldAgentsShars', function (suite) {
    const agentsDir = '/usbkey/extra/agents/';
    const progress = suite.comment;
    suite.afterEach(mockfs.restore);

    const fakeAgentsFiles = {
        'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh': mockfs.file({
            content: '',
            mtime: new Date(2018, 6, 25, 20, 47)}),
        'agent-fc6847e2-6f0b-4282-bf19-1d5448ef4a20.sh': mockfs.file({
            content: '',
            mtime: new Date(2018, 6, 22, 18, 29)}),
        'agents-release-20180510-20180510t044437z-g707200f.sh': mockfs.file({
            content: '',
            mtime: new Date(2018, 5, 21, 18, 43)})
    };
    const moreFakeAgentFiles = {
        'agent-8404446e-31bf-4b5f-ba31-2cebe725f61f.sh': mockfs.file({
            content: '',
            mtime: new Date(2018, 6, 27, 18, 40)}),
        'agents-e7264c70-21b4-4f27-a13e-450265954645.sh': mockfs.file({
            content: '',
            mtime: new Date(2018, 7, 3, 20, 11)})
    };

    suite.test('empty', function (t) {
        mockfs({[agentsDir]: {}});
        t.plan(2);
        usbkey.removeOldAgentsShars({progress: progress}, function (err) {
            t.false(err);
            t.ok(fs.existsSync(agentsDir));
            t.done();
        });
    });

    suite.test('too few to prune', function (t) {
        const fakeFs = {[agentsDir]: fakeAgentsFiles};
        fakeFs[agentsDir]['latest'] = mockfs.symlink({
            path: 'agent-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh'});
        mockfs(fakeFs);
        t.plan(2);
        usbkey.removeOldAgentsShars({progress: progress}, function (err) {
            t.false(err);
            t.equal(fs.readdirSync(agentsDir).length, 4);
            t.done();
        });
    });

    suite.test('prune', function (t) {
        const fakeFs = {[agentsDir]:
                        Object.assign({}, fakeAgentsFiles, moreFakeAgentFiles)};
        fakeFs[agentsDir]['latest'] = mockfs.symlink({
            path: 'agents-e7264c70-21b4-4f27-a13e-450265954645'});
        mockfs(fakeFs);
        t.plan(5);
        usbkey.removeOldAgentsShars({progress: progress}, function (err) {
            t.false(err);
            t.equal(fs.readdirSync(agentsDir).length, 4);
            t.ok(fs.existsSync(
                path.resolve(
                    agentsDir,
                    'agents-e7264c70-21b4-4f27-a13e-450265954645.sh')));
            t.ok(fs.existsSync(
                path.resolve(agentsDir,
                             'agent-8404446e-31bf-4b5f-ba31-2cebe725f61f.sh')));
            t.ok(fs.existsSync(
                path.resolve(
                    agentsDir,
                    'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh')));
            t.done();
        });
    });

    suite.test('prune when eldest is latest', function (t) {
        const fakeFs = {[agentsDir]:
                        Object.assign({}, fakeAgentsFiles, moreFakeAgentFiles)};
        fakeFs[agentsDir]['latest'] = mockfs.symlink({
            path: 'agents-release-20180510-20180510t044437z-g707200f.sh'});
        mockfs(fakeFs);
        t.plan(6);
        usbkey.removeOldAgentsShars({progress: progress}, function (err) {
            t.false(err);
            // Here we end up keeping one more file": "latest, the 3 most recent
            // by mtime, and the file that "latest" points to.
            t.equal(fs.readdirSync(agentsDir).length, 5);
            t.ok(fs.existsSync(
                path.resolve(
                    agentsDir,
                    'agents-release-20180510-20180510t044437z-g707200f.sh')));
            t.ok(fs.existsSync(
                path.resolve(
                    agentsDir,
                    'agents-e7264c70-21b4-4f27-a13e-450265954645.sh')));
            t.ok(fs.existsSync(
                path.resolve(agentsDir,
                             'agent-8404446e-31bf-4b5f-ba31-2cebe725f61f.sh')));
            t.ok(fs.existsSync(
                path.resolve(
                    agentsDir,
                    'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh')));
            t.done();
        });
    });

    suite.end();
});
