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
var fs = require('fs');
var assert = require('assert-plus');

var CURRENT_VERSION = null;
var LATEST_UUID = null;

function checkUpdateResults(t, err, stdout, stderr, moreStrings) {
    if (moreStrings) {
        assert.arrayOfString(moreStrings, 'moreStrings');
    }

    t.ifError(err);
    t.equal(stderr, '');

    if (stdout.indexOf('Already up-to-date') !== -1) {
        t.end();
        return;
    }

    var findStrings = [
        'Update to sdcadm',
        'Download update from',
        'Run sdcadm installer',
        'Updated to sdcadm'
    ];

    if (moreStrings) {
        findStrings = findStrings.concat(moreStrings);
    }

    findStrings.forEach(function (str) {
        t.ok(stdout.match(str), 'check update string present');
    });

    t.end();
}

function getSdcadmBuildstampVersion(t, cb) {
    fs.readFile('/opt/smartdc/sdcadm/etc/buildstamp', {
        encoding: 'utf8'
    }, function (err, data) {
        t.ifError(err);
        t.ok(data);
        cb(data.trim());
    });
}

function getSdcadmChannel(t, cb) {
    if (CURRENT_VERSION === '') {
        cb();
        return;
    }
    var command = 'updates-imgadm get ' + CURRENT_VERSION +
        ' -C \'*\' | json channels[0]';
    exec(command, function (err, stdout, stderr) {
        t.ifError(err, 'getSdcadmChannel error');
        t.equal(stderr, '', 'getSdcadmChannel stderr');
        t.ok(stdout, 'getSdcadmChannel stdout');
        cb(stdout.trim());
    });
}


test('setup', function (t) {
    getSdcadmBuildstampVersion(t, function (data) {
        var updatesCmd = '/opt/smartdc/bin/updates-imgadm list ' +
            'tag.buildstamp=' + data + ' --latest -o uuid -H -C \'*\'';
        exec(updatesCmd, function (err2, stdout, stderr) {
            t.ifError(err2);
            CURRENT_VERSION = stdout.trim();
            t.ok(CURRENT_VERSION);
            t.equal(stderr, '');
            var updatesCmd2 = '/opt/smartdc/bin/updates-imgadm list ' +
                'name=sdcadm --latest -o uuid -H';
            exec(updatesCmd2, function (err3, stdout2, stderr2) {
                t.ifError(err3);
                LATEST_UUID = stdout.trim();
                t.ok(LATEST_UUID);
                t.equal(stderr, '');
                t.end();
            });
        });
    });
});

test('sdcadm self-update --help', function (t) {
    exec('sdcadm self-update --help', function (err, stdout, stderr) {
        t.ifError(err);
        t.notEqual(stdout.indexOf('sdcadm self-update --latest [<options>]'),
            -1);
        t.equal(stderr, '');
        t.end();
    });
});


test('sdcadm self-update --latest --dry-run', function (t) {
    exec('sdcadm self-update --latest --dry-run',
        function (err, stdout, stderr) {
        checkUpdateResults(t, err, stdout, stderr);
    });
});


test('sdcadm self-update --allow-major-update', function (t) {
    exec('sdcadm self-update --allow-major-update --dry-run --latest',
        function (err, stdout, stderr) {
        checkUpdateResults(t, err, stdout, stderr);
    });
});


test('sdcadm self-update --latest --channel=staging', function (t) {
    var cmd = 'sdcadm self-update --latest --channel=staging';
    exec(cmd, function (err, stdout, stderr) {
        checkUpdateResults(t, err, stdout, stderr, ['Using channel staging']);
    });
});


test('sdcadm self-update --latest', function (t) {
    var cmd = 'sdcadm self-update --latest --channel=dev';
    exec(cmd, function (err, stdout, stderr) {
        checkUpdateResults(t, err, stdout, stderr, ['Using channel dev']);
    });
});


test('sdcadm self-update IMAGE_UUID', function (t) {
    getSdcadmChannel(t, function (channel) {
        var cmd = 'sdcadm self-update ' + CURRENT_VERSION + ' -C' + channel;
        exec(cmd, function (err, stdout, stderr) {
            checkUpdateResults(t, err, stdout, stderr,
                ['Using channel ' + channel]);
        });
    });

});
