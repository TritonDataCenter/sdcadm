/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


var test = require('tape').test;
var vasync = require('vasync');

var exec = require('child_process').exec;
var util = require('util');

var DC_MAINT_START_TIME;

function checkHelp(t, subCmd, expectedStr) {
    var cmd = 'sdcadm dc-maint help ' + subCmd;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, util.format('cmd \'%s\' error', cmd));
        t.notEqual(stdout.indexOf(expectedStr), -1, 'Expected stdout');
        t.equal(stderr, '', 'Empty stderr');

        t.end();
    });
}

test('setup', function (t) {
    // Need to set it some time in the future or dc-maint start will fail:
    var d = new Date();
    var time = d.setHours(d.getHours() + 1);
    DC_MAINT_START_TIME = new Date(time).toISOString();
    t.end();
});


test('sdcadm dc-maint help', function (t) {
    checkHelp(t, '', 'Show and modify the DC maintenance mode');
});


test('sdcadm dc-maint start help', function (t) {
    checkHelp(t, 'start', 'Start maintenance mode');
});


test('sdcadm dc-maint stop help', function (t) {
    checkHelp(t, 'stop', 'Stop maintenance mode');
});


test('sdcadm dc-maint status help', function (t) {
    checkHelp(t, 'status', 'Show maintenance status');
});

// --message='Daily Maintenance Time' --eta=`date -u '+%Y-%m-%dT%H:%M:%S'`
/*
 * Note that in case of not having either cloudapi or docker instances
 * this test would fail b/c the related strings would not be matched and
 * instead, the output would be:
 *
 * "No docker instances to update"
 * "No cloudapi instances to update"
 *
 * But, given that on that case putting the DC on maintenance will have no
 * sense, we'll just assume we have cloudapi and docker installed
 */
test('sdcadm dc-maint start', function (t) {

    var cmd = 'sdcadm dc-maint start  --message="Maintenance time" ' +
        '--eta=' + DC_MAINT_START_TIME;
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var expectedStr = [
            'Putting cloudapi in read-only mode',
            'Putting docker in read-only mode',
            'Waiting up to 5 minutes for workflow jobs to drain',
            'Workflow cleared of running and queued jobs'
        ];

        expectedStr.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1, 'Match: ' + str);
        });

        // check jobs are drained
        var cmd2 = 'sdc-workflow /jobs | json -Ha execution';
        exec(cmd2, function (err2, stdout2, stderr2) {
            t.ifError(err2, 'Execution error');
            t.equal(stderr2, '', 'Empty stderr');

            t.ifError(stdout2.match('queued'), 'jobs still queued');
            t.ifError(stdout2.match('running'), 'jobs still running');

            t.end();
        });
    });
});


test('sdcadm dc-maint status (maintenance)', function (t) {
    exec('sdcadm dc-maint status', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        // JSSTYLED
        var match = stdout.match(/DC maintenance ETA: (.+)/);
        t.ok(match);

        var started = match[1];
        t.equal(started, DC_MAINT_START_TIME);

        t.end();
    });
});


test('sdcadm dc-maint status --json', function (t) {
    exec('sdcadm dc-maint status --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var status = JSON.parse(stdout);
        t.deepEqual(Object.keys(status).sort(),
                ['cloudapiMaint', 'dockerMaint', 'eta',
                'maint', 'message', 'startTime']);

        t.equal(status.maint, true);
        t.equal(status.cloudapiMaint, true);
        t.equal(status.dockerMaint, true);
        t.equal(status.eta, DC_MAINT_START_TIME);

        t.end();
    });
});


test('sdcadm dc-maint stop', function (t) {
    exec('sdcadm dc-maint stop', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('Taking cloudapi out of read-only mode\n' +
                                  'Taking docker out of read-only mode'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm dc-maint status (no maintenance)', function (t) {
    exec('sdcadm dc-maint status', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('DC maintenance: off'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm dc-maint status --json (no maintenance)', function (t) {
    exec('sdcadm dc-maint status --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var status = JSON.parse(stdout);
        t.deepEqual(Object.keys(status).sort(),
                ['cloudapiMaint', 'dockerMaint',
                'maint']);

        t.equal(status.maint, false);
        t.equal(status.cloudapiMaint, false);
        t.equal(status.dockerMaint, false);

        t.end();
    });
});
