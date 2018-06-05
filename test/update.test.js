/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */


/*
 * PENDING TESTS:
 *
 * - Test --exclude
 * - Test channels
 */


var shared = require('./shared');

var test = require('tape').test;

var exec = require('child_process').exec;
var readdirSync = require('fs').readdirSync;
var util = require('util');

// We'll try to restore the system to its original state once we're done
// testing updates
var PLAN_PATH;

var PAPI_IMG_UUID;

test('setup', function (t) {
    shared.prepare(t, {external_nics: true});
});


test('sdcadm update --help', function (t) {
    exec('sdcadm update --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('sdcadm update [<options>] <svc>'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm update --dry-run', function (t) {
    exec('sdcadm update papi --dry-run -y', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.notEqual(stdout.indexOf('Finding candidate update images for the ' +
                   '"papi" service.'), -1);

        if (stdout.indexOf('Up-to-date.') === -1) {
            t.notEqual(stdout.indexOf('update "papi" service to image'), -1,
                       'check update string present');
            t.notEqual(stdout.indexOf('Updated successfully'), -1,
                       'check update string present');
        }

        t.end();
    });
});


test('sdcadm update --just-images', function (t) {
    exec('sdcadm update papi --just-images -y', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.notEqual(stdout.indexOf('Finding candidate update images'), -1);

        if (stdout.indexOf('Up-to-date') !== -1) {
            t.end();
            return;
        }

        var findRegex = [
            'This update will make the following changes',
            'Downloading image .+\n.*papi',
            'Imported image .+\n.*papi',
            'Updated successfully'
        ];

        findRegex.forEach(function (regex) {
            t.ok(stdout.match(regex), 'check update regex present');
        });

        var imgUuid = stdout.match(/Imported image (.+?)/)[0];
        PAPI_IMG_UUID = imgUuid;

        var cmd = 'sdc-imgapi /images/' + imgUuid + ' | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var img = JSON.parse(stdout2);
            t.equal(img.name, 'papi');

            t.end();
        });
    });
});


test('sdcadm update', function (t) {
    exec('sdcadm update papi -y', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.ok(stdout.match('Finding candidate update images .+ "papi"'));

        if (stdout.match('Up-to-date')) {
            t.end();
            return;
        }

        var findRegex = [
            'Installing image .+ \\(papi',
            'Reprovisioning papi VM',
            'Wait \\(60s\\) for papi instance',
            'Updated successfully'
        ];

        findRegex.forEach(function (regex) {
            t.ok(stdout.match(regex), 'check update string present:' + regex);
        });

        var update = readdirSync('/var/sdcadm/updates').pop();
        t.ok(update);
        PLAN_PATH = '/var/sdcadm/updates/' + update + '/plan.json';

        var papiUuid = stdout.match('papi instance (.+?) to come up')[1];

        var cmd = 'sdc-vmapi /vms/' + papiUuid + ' | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var papi = JSON.parse(stdout2);
            t.equal(papi.image_uuid, PAPI_IMG_UUID);
            t.end();
        });
    });
});


// at this point, we should definitely be on the newest image
test('sdcadm update (again)', function (t) {
    exec('sdcadm update papi', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.ok(stdout.match('Finding candidate update images .+ "papi"'));
        t.ok(stdout.match('Up-to-date'));

        t.end();
    });
});


test('sdcadm update --force-same-image', function (t) {
    var cmd = 'sdcadm update papi --force-same-image -y';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var findStrings = [
            'Finding candidate update images for the "papi"',
            'update "papi" service to image',
            'Reprovisioning VM',
            'Waiting for papi instance',
            'Updated successfully'
        ];

        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1,
                    util.format('check update string present %s', str));
        });
        t.end();

    });
});

// We've had several issues in the past regarding SAPI's moray client being
// unable to recover from connection lost when we update sapi right after
// non-HA moray. Let's add a test to check if we hit any more issues:
test('update non-HA moray and SAPI consecutively', function (t) {
    var cmd = 'sdcadm up moray sapi --force-same-image --yes';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var findStrings = [
            'Updating moray',
            'Provisioning Temporary moray',
            'Reprovisioning VM',
            'Destroying tmp VM',
            'Updating sapi',
            'Provisioning Temporary sapi',
            'Reprovisioning sapi VM',
            'Stop tmp VM',
            'Updated successfully'
        ];

        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1,
                    util.format('check update string present %s', str));
        });
        t.end();
    });
});

// As part of teardown, we'll not only rollback the updates, but also remove
// the images we imported, since this is the only way to test the whole
// update process for real, despite of slowness:
test('teardown', function (t) {
    if (!PLAN_PATH) {
        t.end();
        return;
    }

    var cmd = 'sdcadm rollback --force --yes -f ' + PLAN_PATH;
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('rollback "papi" service to image'));
        t.ok(stdout.match('Rolledback successfully'));

        t.equal(stderr, '');
        cmd = util.format('sdc-imgadm delete %s', PAPI_IMG_UUID);
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2, 'Execution error');
            t.equal(stderr2, '', 'Empty stderr');

            var str = util.format('Deleted image %s', PAPI_IMG_UUID);
            t.notEqual(stdout2.indexOf(str), -1, 'check image deleted');
            t.end();
        });
    });
});
