/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;
var util = require('util');
var format = util.format;


var common = require('./common');
var shared = require('./shared');

var serverHostnamesFromUUID = {};
var serviceNamesFromUUID = {};
var INSTANCE_TITLES = ['INSTANCE', 'SERVICE', 'HOSTNAME', 'VERSION', 'ALIAS'];
var INSTANCES_DETAILS = [];


function checkHelp(t, command) {
    exec('sdcadm ' + command + ' --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm instances [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
}


function parseInstancesOutput(t, output, expectedTitles) {
    var instancesDetails = common.parseTextOut(output);
    t.ok(instancesDetails.length > 0);

    var titles = instancesDetails.shift();
    t.deepEqual(titles, expectedTitles || INSTANCE_TITLES,
                'check column titles');

    return instancesDetails;
}


function checkInstancesDetails(t, instancesDetails) {
    instancesDetails = instancesDetails.map(function (item) {
        return ({
            instance: item[0],
            service: item[1],
            hostname: item[2],
            version: item[3],
            alias: item[4]
        });
    });

    common.checkInsts(t, {
        inputs: instancesDetails,
        serviceNamesFromUUID: serviceNamesFromUUID,
        serverHostnamesFromUUID: serverHostnamesFromUUID
    }, function () {
        t.end();
    });
}


// ---


test('prepare', function (t) {
    shared.prepare(t, {docker: true});
});

// Preload Servers and SAPI services
test('setup', function (t) {
    var cmd = 'sdc-sapi /services | json -H';
    exec(cmd, function execCb(err, stdout) {
        t.ifError(err, 'No error preloading SAPI services');

        var svcs = common.parseJsonOut(stdout);
        if (!svcs) {
            t.ok(false, 'failed to parse JSON for cmd ' + cmd);
            t.end();
            return;
        }
        svcs.forEach(function (svc) {
            serviceNamesFromUUID[svc.uuid] = svc.name;
        });
        var cmd2 = 'sdc-cnapi /servers?setup=true|json -H';
        exec(cmd2, function execCb2(err2, stdout2) {
            t.ifError(err2, 'No error preloading CNAPI servers');

            var servers = common.parseJsonOut(stdout2);
            if (!servers) {
                t.ok(false, 'failed to parse JSON for cmd ' + cmd2);
                t.end();
                return;
            }
            servers.forEach(function (server) {
                serverHostnamesFromUUID[server.uuid] = server.hostname;
            });
            t.end();
        });
    });
});

test('sdcadm instances --help', function (t) {
    checkHelp(t, 'instances');
});


test('sdcadm insts --help', function (t) {
    checkHelp(t, 'insts');
});


test('sdcadm instances', function (t) {
    exec('sdcadm instances', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        common.DEFAULT_VM_SERVICES.forEach(function (svcName) {
            var found = stdout.indexOf(svcName) !== -1;
            t.ok(found, svcName + ' in instances output');
        });

        // global, so other tests can compare against
        INSTANCES_DETAILS = parseInstancesOutput(t, stdout);
        t.ok(INSTANCES_DETAILS.length > 0);

        checkInstancesDetails(t, common.deepCopy(INSTANCES_DETAILS));
    });
});


test('sdcadm insts', function (t) {
    exec('sdcadm insts', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.deepEqual(parseInstancesOutput(t, stdout), INSTANCES_DETAILS);
        t.end();
    });
});


test('sdcadm instances -H', function (t) {
    exec('sdcadm instances -H', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.equal(stdout.indexOf('INSTANCE'), -1);

        t.end();
    });
});


test('sdcadm instances --json', function (t) {
    exec('sdcadm instances --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var details = common.parseJsonOut(stdout);
        if (!details) {
            t.ok(false, 'failed to parse JSON');
            t.end();
            return;
        }

        var instDetails = {};
        details.forEach(function (inst) {
            instDetails[inst.instance] = inst;
        });

        INSTANCES_DETAILS.forEach(function (oldDetails) {
            var id = oldDetails[0];
            // No instance id
            if (id === '-') {
                return;
            }
            var jsonDetails = instDetails[id];
            t.equal(jsonDetails.type, (
                (oldDetails[4] !== '-') ? 'vm' : 'agent'
            ), id + ' type');
            t.equal(jsonDetails.service, oldDetails[1], id + ' service');
            t.equal(jsonDetails.hostname, oldDetails[2], id + ' hostname');
            t.equal(jsonDetails.version, oldDetails[3], id + ' version');
            if (oldDetails[4] !== '-') {
                t.equal(jsonDetails.alias, oldDetails[4], id + ' alias');
            }
        });

        t.end();
    });
});


test('sdcadm instances -o', function (t) {
    var cmd = 'sdcadm instances -o type,instance,version';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expectedTitles = ['TYPE', 'INSTANCE', 'VERSION'];
        var data = parseInstancesOutput(t, stdout, expectedTitles);

        var insts = data.map(function (r) {
            return [ r[1], r[2] ];
        });

        var prevInsts = INSTANCES_DETAILS.map(function (r) {
            return [ r[0], r[3] ];
        });

        t.deepEqual(insts, prevInsts);

        t.end();
    });
});


test('sdcadm instances -s', function (t) {
    exec('sdcadm instances -s instance', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var insts = parseInstancesOutput(t, stdout).filter(function (item) {
            return item[0] !== '-';
        });
        var sortedInsts = common.deepCopy(insts).sort(function (a, b) {
            return (a[0] < b[0]) ? -1 : 1;
        });

        t.deepEqual(insts, sortedInsts);

        t.end();
    });
});


test('dockerlogger insts of removed servers', function (t) {
    var svcCmd = 'sdc-sapi /services?name=dockerlogger|json -H';
    exec(svcCmd, function execCb(err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        var services = JSON.parse(stdout.trim());
        t.ok(Array.isArray(services));
        t.ok(services[0].uuid);

        var instCmd = 'sdc-sapi /instances -X POST -d \'{' +
            '"uuid": "f189fd84-740d-4558-b2ea-36c62570e383",' +
            format('"service_uuid": "%s",', services[0].uuid) +
            '"params": {' +
            '    "server_uuid": "44454c4c-4400-1057-804e-b5c04f383432"' +
            '},' +
            '"type": "agent"' +
        '}\'';

        exec(instCmd, function execCb2(err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            // TOOLS-1492: Orphan server instances should not throw exceptions
            // and sdcadm should just ignore them:
            var listCmd = 'sdcadm insts svc=dockerlogger -j';
            exec(listCmd, function execCb3(err3, stdout3, stderr3) {
                t.ifError(err3);
                t.equal(stderr3, '');

                var listOfInsts = JSON.parse(stdout.trim());
                t.ok(Array.isArray(listOfInsts));

                var delCmd = 'sdc-sapi ' +
                    '/instances/f189fd84-740d-4558-b2ea-36c62570e383 ' +
                    '-X DELETE';
                exec(delCmd, function execCb4(err4, stdout4, stderr4) {
                    t.ifError(err4);
                    t.equal(stderr4, '');

                    t.end();
                });
            });
        });
    });
});
