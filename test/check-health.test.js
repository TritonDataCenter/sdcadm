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

        t.equal(vmDetails.uuid,  details[0]); // sanity check
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


// TODO: should intentionally break something and see if check-health notices
test('sdcadm check-health', function (t) {
    exec('sdcadm check-health', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var healthDetails = parseHealthOutput(stdout);

        var titles = healthDetails.shift();
        t.deepEqual(titles, HEALTH_TITLES);

        checkHealthDetails(t, healthDetails);
    });
});
