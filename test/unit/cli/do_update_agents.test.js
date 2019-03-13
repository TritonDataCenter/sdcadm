/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

var assert = require('assert-plus');

const mockfs = require('mock-fs');
const tap = require('tap');
const VError = require('verror');

const errors = require('../../../lib/errors');

const do_update_agents = require('../../../lib/cli/do_update_agents');
const UpdateAgents = do_update_agents._UpdateAgents;
const sha1Path = do_update_agents._sha1Path;
const testutil = require('../testutil');
const MockUI = require('../../../lib/cli/ui').MockUI;


class StubImgApi {
    getImageFile(uuid, filePath, account, options, callback) {
        assert.string(uuid, 'uuid');
        assert.string(filePath, 'filePath');
        if (typeof (account) === 'function') {
            callback = account;
            options = {};
            account = undefined;
        } else if (typeof (options) === 'function') {
            callback = options;
            options = {};
        }
        assert.func(callback, 'callback');

        fs.writeFileSync(filePath, 'fake ' + uuid);
        callback();
    }
}


function testCmd(opts) {
    const log = testutil.createBunyanLogger(tap);

    const defaults = {
        sdcadm: {log: log, updates: new StubImgApi()},
        agentsshar: 'latest',
        concurrency: 4,
        progress: tap.comment,
        ui: new MockUI({write: tap.comment}),
        all: true
    };
    return new UpdateAgents(Object.assign({}, defaults, opts));
}


tap.test('sha1Path', function (suite) {
    const testFiles = {'empty': '',
                       'quote': 'Java is to JavaScript what Car is to Carpet.'};
    suite.afterEach(mockfs.restore);

    suite.test('empty', function (t) {
        mockfs({'/test': testFiles});
        t.plan(2);
        sha1Path('/test/empty', function (err, hex) {
            t.false(err);
            t.equal(hex, 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
            t.done();
        });
    });

    suite.test('quote', function (t) {
        mockfs({'/test': testFiles});
        t.plan(2);
        sha1Path('/test/quote', function (err, hex) {
            t.false(err);
            t.equal(hex, 'f9d44427c3763e5b9d76837f72428841fdde87d6');
            t.done();
        });
    });

    suite.done();
});


tap.test('UpdateAgents._stepVerifyFilepath', function (suite) {

    suite.test('full update', function (t) {
        const subject = testCmd({justUpdateSymlink: false});
        t.plan(1);
        subject._stepVerifyFilepath({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('just symlink with filepath', function (t) {
        const subject = testCmd({justUpdateSymlink: true});
        subject.filepath = '/test/foo';
        t.plan(1);
        subject._stepVerifyFilepath({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('just symlink no filepath', function (t) {
        const subject = testCmd({justUpdateSymlink: true});
        t.plan(1);
        subject._stepVerifyFilepath({}, function (err) {
            t.type(err, Error);
            t.done();
        });
    });

    suite.done();
});


tap.test('UpdateAgents._stepHaveSharAlreadyFromLink', function (suite) {
    suite.afterEach(mockfs.restore);

    suite.test('shortcut', function (t) {
        mockfs({'/usbkey/extra/agents/': {}});
        const subject = testCmd();
        subject.filepath = '/test/foo';
        t.plan(1);
        subject._stepHaveSharAlreadyFromLink({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('not a link', function (t) {
        mockfs({'/usbkey/extra/agents/': {'latest': ''}});
        const subject = testCmd();
        t.plan(2);
        subject._stepHaveSharAlreadyFromLink({}, function (err) {
            t.type(err, errors.UpdateError);
            t.equal(VError.cause(err).code, 'EINVAL');
            t.done();
        });
    });

    suite.test('skip missing link', function (t) {
        mockfs({'/usbkey/extra/agents/': {}});
        const subject = testCmd();
        t.plan(2);
        subject._stepHaveSharAlreadyFromLink({}, function (err) {
            t.false(err);
            t.false(subject.filepath);
            t.done();
        });
    });

    suite.test('good hash', function (t) {
        const content = 'this is a fantastic image';
        const hash = crypto.createHash('sha1').update(content).digest('hex');
        const fname = 'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh';
        mockfs({'/usbkey/extra/agents/':
                {[fname]: content,
                 'latest': mockfs.symlink({
                     path: fname})
                }});

        const subject = testCmd();
        subject.image = {files: [{sha1: hash}]};
        t.plan(2);
        subject._stepHaveSharAlreadyFromLink({}, function (err) {
            t.false(err);
            t.equal(subject.filepath,
                    path.resolve('/usbkey/extra/agents/', fname));
            t.done();
        });
    });

    suite.test('bad hash', function (t) {
        const content = 'this is a fantastic image';
        const hash = crypto.createHash('sha1').update('wrong!').digest('hex');
        const fname = 'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh';
        mockfs({'/usbkey/extra/agents/':
                {[fname]: content,
                 'latest': mockfs.symlink({
                     path: fname})
                }});

        const subject = testCmd();
        subject.image = {files: [{sha1: hash}]};
        t.plan(2);
        subject._stepHaveSharAlreadyFromLink({}, function (err) {
            t.false(err);
            t.false(subject.filepath);
            t.done();
        });
    });

    suite.done();
});


tap.test('UpdateAgents._stepHaveSharAlreadyFromDownload', function (suite) {
    suite.afterEach(mockfs.restore);

    suite.test('shortcut', function (t) {
        mockfs({'/usbkey/extra/agents/': {}});
        const subject = testCmd();
        subject.filepath = '/test/foo';
        t.plan(1);
        subject._stepHaveSharAlreadyFromDownload({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('does not exist', function (t) {
        mockfs({'/var/tmp': {}});
        const subject = testCmd();
        subject.image = {uuid: 'ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749'};
        t.plan(2);
        subject._stepHaveSharAlreadyFromDownload({}, function (err) {
            t.false(err);
            t.false(subject.filepath);
            t.done();
        });
    });

    suite.test('good hash', function (t) {
        const content = 'high quality bits';
        const hash = crypto.createHash('sha1').update(content).digest('hex');
        const fname = 'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh';
        mockfs({'/var/tmp': {[fname]: content}});
        const subject = testCmd();
        subject.image = {uuid: 'ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749',
                     files: [{sha1: hash}]};
        t.plan(2);
        subject._stepHaveSharAlreadyFromDownload({}, function (err) {
            t.false(err);
            t.equal(subject.filepath, path.resolve('/var/tmp/', fname));
            t.done();
        });
    });

    suite.test('bad hash', function (t) {
        const content = 'high quality bits';
        const hash = crypto.createHash('sha1').update('wrong!').digest('hex');
        const fname = 'agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh';
        mockfs({'/var/tmp': {[fname]: content}});
        const subject = testCmd();
        subject.image = {uuid: 'ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749',
                     files: [{sha1: hash}]};
        t.plan(2);
        subject._stepHaveSharAlreadyFromDownload({}, function (err) {
            t.false(err);
            t.false(subject.filepath);
            t.done();
        });
    });

    suite.done();
});


tap.test('UpdateAgents._stepCreateLatestSymlink', function (suite) {
    suite.afterEach(mockfs.restore);

    suite.test('shortcut: justDownload', function (t) {
        mockfs({'/usbkey/extra/agents/': {}});
        const subject = testCmd({justDownload: true});
        t.plan(1);
        subject._stepCreateLatestSymlink({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('shortcut: skipLatestSymlink', function (t) {
        mockfs({'/usbkey/extra/agents/': {}});
        const subject = testCmd({skipLatestSymlink: true});
        t.plan(1);
        subject._stepCreateLatestSymlink({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('silently ignore ENOENT', function (t) {
        mockfs({'/usbkey/extra/agents/': {'new-agent.sh': ''}});
        const subject = testCmd();
        t.plan(2);
        subject._stepCreateLatestSymlink(
            {fname: 'new-agent.sh'}, function (err) {
                t.false(err);
                t.equals(fs.readlinkSync('/usbkey/extra/agents/latest'),
                         'new-agent.sh');
                t.done();
            });
    });

    suite.test('existing symlink', function (t) {
        mockfs({'/usbkey/extra/agents/': {
            'old-agent.sh': '',
            'new-agent.sh': '',
            'latest': mockfs.symlink({path: 'old-agent.sh'})
        }});
        const subject = testCmd();
        t.plan(2);
        subject._stepCreateLatestSymlink(
            {fname: 'new-agent.sh'}, function (err) {
                t.false(err);
                t.equals(fs.readlinkSync('/usbkey/extra/agents/latest'),
                         'new-agent.sh');
                t.done();
            });
    });


    suite.done();
});


tap.test('UpdateAgents._stepDownloadAgentsshar', function (suite) {
    suite.afterEach(mockfs.restore);

    suite.test('shortcut', function (t) {
        mockfs({'/usbkey/extra/agents/': {},
                '/var/tmp': {}});
        const subject = testCmd();
        subject.filepath = '/test/foo';
        t.plan(1);
        subject._stepDownloadAgentsshar({}, function (err) {
            t.false(err);
            t.done();
        });
    });

    suite.test('download', function (t) {
        mockfs({'/usbkey/extra/agents/': {},
                '/var/tmp': {}});
        const subject = testCmd();
        subject.image = {uuid: 'ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749'};
        t.plan(2);
        subject._stepDownloadAgentsshar({}, function (err) {
            t.false(err);
            t.ok(fs.existsSync(
                '/var/tmp/agents-ebc7b8c2-8b3a-409b-b2d9-3c23f0e2b749.sh'));
            t.done();
        });
    });

    suite.done();
});
