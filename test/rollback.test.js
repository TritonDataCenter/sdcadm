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
var readdirSync = require('fs').readdirSync;

var PLAN_PATH = ''; // filled in by setup


// we do this to ensure we have a plan to work with
test('setup', function (t) {
    var cmd = 'sdcadm update papi --force-same-image --yes';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('Updated successfully'));
        t.equal(stderr, '');

        var update = readdirSync('/var/sdcadm/updates').pop();
        t.ok(update);
        PLAN_PATH = '/var/sdcadm/updates/' + update + '/plan.json';

        t.end();
    });
});


test('sdcadm rollback --help', function (t) {
    exec('sdcadm rollback --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm rollback [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm rollback', function (t) {
    exec('sdcadm rollback', function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.ok(stderr.match('plan to rollback must be specified'));

        t.end();
    });
});


test('sdcadm rollback -f', function (t) {
    var cmd = 'sdcadm rollback -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.ok(stderr.match('dependencies not implemented'));

        t.end();
    });
});


test('sdcadm rollback --dry-run -f', function (t) {
    var cmd = 'sdcadm rollback --dry-run -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.ok(stderr.match('dependencies not implemented.'));

        t.end();
    });
});


test('sdcadm rollback --dry-run --force --yes -f', function (t) {
    var cmd = 'sdcadm rollback --dry-run --yes --force -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('rollback "papi" service to image'));
        t.ok(stdout.match('Rolledback successfully'));

        t.equal(stderr, '');

        t.end();
    });
});


// TODO: check the vm was properly rolled back (somehow)
test('sdcadm rollback --force --yes -f', function (t) {
    var cmd = 'sdcadm rollback --force --yes -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('rollback "papi" service to image'));
        t.ok(stdout.match('Rolledback successfully'));

        t.equal(stderr, '');

        exec('vmadm list | grep papi', function (err2, stdout2, stderr2) {
            t.ifError(err2);

            stdout2.split('\n').forEach(function (line) {
                if (line !== '') {
                    t.ok(line.match('running'));
                }
            });

            t.end();
        });
    });
});
