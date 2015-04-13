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
            return t.end();
        }

        var findRegex = [
            'This update will make the following changes',
            'Downloading image .+ \(papi',
            'Imported image .+ \(papi',
            'Updated successfully'
        ];

        findRegex.forEach(function (regex) {
            t.ok(regex.match(stdout), 'check update regex present');
        });

        var imgUuid = stdout.match('Imported image (.+?) \(')[0];

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
            return t.end();
        }

        var findRegex = [
            'Installing image .+ \(papi',
            'Reprovisioning papi VM',
            'Wait (60s) for papi instance',
            'Updated successfully'
        ];

        findRegex.forEach(function (regex) {
            t.ok(stdout.match(regex), 'check update string present');
        });

        var papiUuid = stdout.match('papi instance (.+?) to come up')[1];

        var cmd = 'sdc-vmapi /vms/' + papiUuid + ' | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var papi = JSON.parse(stdout2);

            // TODO: should be papi.state, but there's a bug (?) right now where
            // vmapi gets the state wedged in 'provisioning', even if it's done
            t.equal(papi.zone_state, 'running');

            return t.end();
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
            'Reprovisioning papi VM',
            'Wait (60s) for papi instance',
            'Updated successfully'
        ];

        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1, 'check update string present');
        });

        var papiUuid = stdout.match('papi instance (.+?) to come up')[1];

        cmd = 'sdc-vmapi /vms/' + papiUuid + ' | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var papi = JSON.parse(stdout2);

            // TODO: papi.state bug (see other TODO above)
            t.equal(papi.zone_state, 'running');

            return t.end();
        });
    });
});


// TODO: channels