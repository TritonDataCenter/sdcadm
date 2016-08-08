/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */


var test = require('tape').test;
var vasync = require('vasync');

var exec = require('child_process').exec;
var util = require('util');
var fs = require('fs');


var common = require('./common');
var UUID_RE = common.UUID_RE;

var CURRENT_AGENTS_VERSION;
var CURRENT_AGENTS_IMG;
var LATEST_AGENTS_IMG;

function getCurrentAgentsVersion(t, cb) {
    var latest = '/usbkey/extra/agents/latest';
    fs.readlink(latest, function (err, linkString) {
        t.ifError(err);
        t.ok(linkString);
        CURRENT_AGENTS_VERSION = linkString.match(/agents?-(.+)\.sh/)[1];
        cb();
    });
}

function getCurrentAgentsImgManifest(t, cb) {
    if (!CURRENT_AGENTS_VERSION) {
        cb();
        return;
    }
    var command;
    if (CURRENT_AGENTS_VERSION.match(UUID_RE)) {
        command = 'updates-imgadm get ' + CURRENT_AGENTS_VERSION;
    } else {
        command = 'updates-imgadm list version=~master' +
        CURRENT_AGENTS_VERSION + ' --json';
    }
    exec(command, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');
        var jsonDetails = common.parseJsonOut(stdout);
        if (jsonDetails.length) {
            CURRENT_AGENTS_IMG = jsonDetails[0];
        } else if (jsonDetails.uuid) {
            CURRENT_AGENTS_IMG = jsonDetails;
        }
        cb();
    });
}


function getLatestAgentsImgManifest(t, cb) {
    var command = 'updates-imgadm list name=agentsshar --latest --json';
    exec(command, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');
        var jsonDetails = common.parseJsonOut(stdout);
        if (jsonDetails.length) {
            LATEST_AGENTS_IMG = jsonDetails[0];
        }
        cb();
    });
}


function checkHelp(t, subCmd, expectedStr) {
    var cmd = 'sdcadm experimental ' + subCmd + ' --help';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, util.format('cmd \'%s\' error', cmd));
        t.notEqual(stdout.indexOf(expectedStr), -1, 'Expected stdout');
        t.equal(stderr, '', 'Empty stderr');

        t.end();
    });
}


test('setup', function (t) {
    vasync.pipeline({
        funcs: [
            function (_, next) {
                getCurrentAgentsVersion(t, next);
            },
            function (_, next) {
                getCurrentAgentsImgManifest(t, next);
            },
            function (_, next) {
                getLatestAgentsImgManifest(t, next);
            }
        ]
    }, function () {
        t.end();
    });
});


test('sdcadm experimental --help', function (t) {
    checkHelp(t, '', 'sdcadm experimental [OPTIONS] COMMAND');
});


test('sdcadm experimental update-agents --help', function (t) {
    checkHelp(t, 'update-agents', 'Update GZ agents on servers in the DC');
});


test('sdcadm experimental update-agents --just-download', function (t) {
    var cmd = 'sdcadm experimental update-agents --just-download ' +
        '--latest --all --yes';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        t.ok(stdout.match('Finding latest "agentsshar" on updates server'));
        t.ok(stdout.match('Latest is agentsshar'));

        if (!stdout.match('agentsshar already exists at')) {
            t.ok(stdout.match('Downloading agentsshar from updates server'));
        } else {
            t.ok(stdout.match('Agentsshar is already downloaded to'));
        }

        t.end();
    });
});


test('sdcadm experimental update-agents --force --latest --yes', function (t) {
    var cmd = 'sdcadm experimental update-agents --latest --yes -a';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        t.ok(stdout.match('The latest agentsshar already exists'));
        t.ok(stdout.match('Finding servers to update'));
        t.ok(stdout.match('This update will make the following changes'));
        t.ok(stdout.match('Starting agentsshar update'));
        t.ok(stdout.match('Successfully updated agents'));
        t.end();
    });
});


test('sdcadm experimental update-agents <img uuid>', function (t) {
    if (!CURRENT_AGENTS_IMG) {
        t.end();
        return;
    }
    var cmd = 'sdcadm experimental update-agents ' + CURRENT_AGENTS_IMG.uuid +
              ' --yes -a';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        t.ok(stdout.match('Finding servers to update'));
        t.ok(stdout.match('This update will make the following changes'));
        t.ok(stdout.match('Starting agentsshar update'));
        t.ok(stdout.match('Successfully updated agents'));
        t.end();
    });
});


test('sdcadm experimental update-other --help', function (t) {
    var expected = 'Temporary grabbag for small SDC update steps';
    checkHelp(t, 'update-other', expected);
});


test('sdcadm experimental update-other', function (t) {
    var mahiDomain = '';
    var papiDomain = '';
    var sapiUrl    = '';

    vasync.pipeline({
        funcs: [
            function runUpdate(_, next) {
                exec('sdcadm experimental update-other',
                     function (err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');

                    t.notEqual(stdout.indexOf('Running VMAPI migrations'), -1,
                            'check output');

                    next();
                });
            },

            function checkDomains(_, next) {
                var cmd = 'sdc-sapi /applications?name=sdc | json -H';

                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'SAPI error');
                    t.equal(stderr, '', 'Empty stderr');

                    var sdc = JSON.parse(stdout)[0];
                    t.ok(sdc);

                    mahiDomain = sdc.metadata.MAHI_SERVICE;
                    papiDomain = sdc.metadata.PAPI_SERVICE;
                    sapiUrl    = sdc.metadata['sapi-url'];

                    t.ok(mahiDomain);
                    t.ok(papiDomain);
                    t.ok(sapiUrl);

                    next();
                });
            },

            function checkServices(_, next) {
                var cmd = 'sdc-sapi /services | json -H';
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'SAPI error');
                    t.equal(stderr, '', 'Empty stderr');

                    var services = JSON.parse(stdout);

                    var vms = services.filter(function (svc) {
                        return svc.type === 'vm';
                    });

                    var mahi = services.filter(function (svc) {
                        return svc.name === 'mahi';
                    })[0];

                    var papi = services.filter(function (svc) {
                        return svc.name === 'papi';
                    })[0];

                    t.ok(mahi, 'mahi service present');
                    t.ok(papi, 'papi service present');

                    t.equal(mahi.metadata.SERVICE_DOMAIN, mahiDomain);
                    t.equal(papi.metadata.SERVICE_DOMAIN, papiDomain);

                    t.equal(sapiUrl, mahi.metadata['sapi-url']);
                    t.equal(sapiUrl, papi.metadata['sapi-url']);

                    vms.forEach(function (vm) {
                        t.equal(vm.params.maintain_resolvers, true,
                                vm.name + ' name has maintain_resolvers');
                    });

                    t.end();
                });
            }
        ]
    }, function (resErr) {
        t.end();
    });
});


test('sdcadm experimental add-new-agent-svcs --help', function (t) {
    var expected = 'Temporary grabbag for installing the SDC global zone new';
    checkHelp(t, 'add-new-agent-svcs', expected);
});


test('sdcadm experimental add-new-agent-svcs', function (t) {
    exec('sdcadm experimental add-new-agent-svcs',
         function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var expected = [
            'Checking for minimum SAPI version',
            'Checking if service \'vm-agent\' exists',
            'Checking if service \'net-agent\' exists',
            'Checking if service \'cn-agent\' exists',
            'Add new agent services finished'
        ];

        expected.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1, 'output contains: ' + str);
        });

        exec('svcs | grep online', function (err2, stdout2, stderr2) {
            t.ifError(err2);

            t.ok(stdout.match('vm-agent'),  'vm-agent SMF service exists');
            t.ok(stdout.match('cn-agent'),  'cn-agent SMF service exists');
            t.ok(stdout.match('net-agent'), 'net-agent SMF service exists');

            t.end();
        });
    });
});
