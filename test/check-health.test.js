/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;
var common = require('./common');


var HEALTH_TITLES = ['INSTANCE', 'SERVICE', 'HOSTNAME', 'ALIAS', 'HEALTHY'];
var HEALTH_DETAILS = [];


function parseHealthOutput(output) {
    return common.parseTextOut(output).filter(function (r) {
        // TODO: we should check everything, not just VMs
        return r[3] !== '-';
    });
}


// TODO: need to check if service and hostname are correct
function checkHealthDetails(t, healthDetails) {
    if (healthDetails.length === 0) {
        return t.end();
    }

    var details = healthDetails.pop();

    var cmd = 'sdc-vmapi /vms/' + details[0] + ' | json -H';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        var vmDetails = common.parseJsonOut(stdout);
        if (!vmDetails) {
            t.ok(false, 'failed to parse JSON for cmd ' + cmd);
            return t.end();
        }

        t.equal(vmDetails.uuid,  details[0], 'uuid should match');  // sanity
        t.equal(vmDetails.alias, details[3], 'alias should match');

        checkHealthDetails(t, healthDetails);
    });
}


// ---


test('sdcadm check-health --help', function (t) {
    exec('sdcadm check-health --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm check-health [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm check-health', function (t) {
    exec('sdcadm check-health', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        common.DEFAULT_SERVICES.forEach(function (svcName) {
            var found = stdout.indexOf(svcName) !== -1;
            t.ok(found, svcName + ' in instances output');
        });

        var healthDetails = parseHealthOutput(stdout);

        var titles = healthDetails.shift();
        t.deepEqual(titles, HEALTH_TITLES, 'check column titles');

        healthDetails.forEach(function (inst) {
            t.equal(inst[4], 'true', inst[0] + ' instance is healthy');
        });

        // global, so other tests can compare against
        HEALTH_DETAILS = healthDetails;

        checkHealthDetails(t, common.deepCopy(healthDetails));
    });
});


test('sdcadm check-health -H', function (t) {
    exec('sdcadm check-health -H', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.equal(stdout.indexOf('INSTANCE'), -1);

        t.end();
    });
});


test('sdcadm check-health --json', function (t) {
    exec('sdcadm check-health --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var details = common.parseJsonOut(stdout);
        if (!details) {
            t.ok(false, 'failed to parse JSON');
            return t.end();
        }

        var healthDetails = {};
        details.forEach(function (inst) {
            healthDetails[inst.instance] = inst;
        });

        HEALTH_DETAILS.forEach(function (oldDetails) {
            var vmUuid = oldDetails[0];
            var jsonDetails = healthDetails[vmUuid];
            t.equal(jsonDetails.type,    'vm',           vmUuid + ' type');
            t.equal(jsonDetails.service,  oldDetails[1], vmUuid + ' service');
            t.equal(jsonDetails.hostname, oldDetails[2], vmUuid + ' hostname');
            t.equal(jsonDetails.alias,    oldDetails[3], vmUuid + ' alias');

            var oldHealthy = oldDetails[4];
            t.notEqual(['true', 'false'].indexOf(oldHealthy), -1);
            oldHealthy = (oldHealthy === 'true' ? true : false);
            t.equal(jsonDetails.healthy,  oldHealthy, vmUuid + ' hostname');
        });

        t.end();
    });
});


test('sdcadm check-health -q', function (t) {
    exec('sdcadm check-health -q', function (err, stdout, stderr) {
        t.ifError(err);

        t.equal(stdout, '');
        t.equal(stderr, '');

        t.end();
    });
});


// TODO: this won't work on an HA standup
// TODO: simply disabling an SMF service instance is one step in test, but we
// need something more subtle yet brutal (like disabling manatee)
test('disable papi for health check', function (t) {
    exec('sdc-login papi svcadm disable papi', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        t.end();
    });
});


test('sdcadm check-health with disabled papi', function (t) {
    exec('sdcadm check-health', function (err, stdout, stderr) {
        t.equal(err && err.code, 1, 'errcode is 1');

        t.notEqual(stderr, 'Some instances appear unhealthy'.indexOf(stderr),
                   -1);

        var unhealthyPapis = parseHealthOutput(stdout).filter(function (inst) {
            return inst[1] === 'papi' && inst[4] === 'false';
        });

        t.equal(unhealthyPapis.length, 1, 'unhealthy PAPI found');

        t.end();
    });
});


test('sdcadm check-health -q with disabled papi', function (t) {
    t.end();
});


test('enable papi after health check', function (t) {
    exec('sdc-login papi svcadm enable papi', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        t.end();
    });
});