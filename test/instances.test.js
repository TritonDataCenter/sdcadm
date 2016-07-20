/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;
var util = require('util');
var format = util.format;
var common = require('./common');


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

    return instancesDetails.filter(function (r) {
        // TODO: we should check everything, not just VMs
        return r[4] !== '-';
    });
}


/*
 * Recursive function to check the existence of a VM, and its alias and version
 * are correct.
 */
function checkInstancesDetails(t, instancesDetails) {
    if (instancesDetails.length === 0) {
        return t.end();
    }

    function recur() {
        checkInstancesDetails(t, instancesDetails); // recursive call
    }

    var instanceDetails = instancesDetails.pop();
    var vmUuid  = instanceDetails[0];
    var version = instanceDetails[3];
    var alias   = instanceDetails[4];

    var cmd = 'sdc-vmapi /vms/' + vmUuid + ' | json -H';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        var vmInfo = common.parseJsonOut(stdout);
        if (!vmInfo) {
            t.ok(false, 'failed to parse JSON for cmd ' + cmd);
            return recur();
        }

        t.equal(vmInfo.alias, alias, 'check VM alias is ' + alias);
        t.notEqual(vmInfo.state, 'failed', 'check state for VM ' + vmUuid);

        var imgUuid = vmInfo.image_uuid;
        var cmd2 = 'sdc-imgapi /images/' + imgUuid + ' | json -H';

        exec(cmd2, function (err2, stdout2, stderr2) {
            t.ifError(err2);

            var imgInfo = common.parseJsonOut(stdout2);
            if (!imgInfo) {
                t.ok(false, 'failed to parse JSON for cmd ' + cmd2);
                return recur();
            }

            t.equal(imgInfo.version, version, 'check version for VM ' + vmUuid);

            recur();
        });
    });
}


// ---

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

        common.DEFAULT_SERVICES.forEach(function (svcName) {
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
            return t.end();
        }

        var vmsDetails = {};
        details.forEach(function (vm) {
            vmsDetails[vm.zonename] = vm;
        });

        INSTANCES_DETAILS.forEach(function (oldDetails) {
            var vmUuid = oldDetails[0];
            var jsonDetails = vmsDetails[vmUuid];
            t.equal(jsonDetails.type,    'vm',           vmUuid + ' type');
            t.equal(jsonDetails.service,  oldDetails[1], vmUuid + ' service');
            t.equal(jsonDetails.hostname, oldDetails[2], vmUuid + ' hostname');
            t.equal(jsonDetails.version,  oldDetails[3], vmUuid + ' version');
            t.equal(jsonDetails.alias,    oldDetails[4], vmUuid + ' alias');
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

        // TODO: should check more than just vms
        var vms = data.filter(function (r) {
            return r[0] === 'vm';
        }).map(function (r) {
            return [ r[1], r[2] ];
        });

        var prevVms = INSTANCES_DETAILS.map(function (r) {
            return [ r[0], r[3] ];
        });

        t.deepEqual(vms, prevVms);

        t.end();
    });
});


test('sdcadm instances -s', function (t) {
    exec('sdcadm instances -s instance', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var vms = parseInstancesOutput(t, stdout);
        var sortedVms = common.deepCopy(vms).sort(function (a, b) {
            return (a[0] < b[0]) ? -1 : 1;
        });

        t.deepEqual(vms, sortedVms);

        t.end();
    });
});


test('dockerlogger insts of removed servers', function (t) {
    var svcCmd = 'sdc-sapi /services?name=dockerlogger|json -H';
    exec(svcCmd, function (err, stdout, stderr) {
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

        exec(instCmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            // TOOLS-1492: Orphan server instances should not throw exceptions
            // and sdcadm should just ignore them:
            var listCmd = 'sdcadm insts svc=dockerlogger -j';
            exec(listCmd, function (err3, stdout3, stderr3) {
                t.ifError(err3);
                t.equal(stderr3, '');

                var listOfInsts = JSON.parse(stdout.trim());
                t.ok(Array.isArray(listOfInsts));

                var delCmd = 'sdc-sapi ' +
                    '/instances/f189fd84-740d-4558-b2ea-36c62570e383 ' +
                    '-X DELETE';
                exec(delCmd, function (err4, stdout4, stderr4) {
                    t.ifError(err4);
                    t.equal(stderr4, '');

                    t.end();
                });
            });
        });
    });
});
