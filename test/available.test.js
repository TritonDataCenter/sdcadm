/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


var test = require('tape').test;

var exec = require('child_process').exec;
var util = require('util');

var common = require('./common');

var AVAIL_TITLES = ['SERVICE', 'IMAGE', 'VERSION'];


function parseAvailOutput(t, output, expectedTitles) {
    var availDetails = common.parseTextOut(output);
    t.ok(availDetails.length > 0);

    var titles = availDetails.shift();
    t.deepEqual(titles, expectedTitles || AVAIL_TITLES,
                'check column titles');

    return availDetails;
}


test('sdcadm available --help', function (t) {
    exec('sdcadm available --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf(
                    'sdcadm avail(able) [<options>] [<svc>]'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm avail', function (t) {
    exec('sdcadm avail', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var availDetails = parseAvailOutput(t, stdout);
        var foundSvcs = [];
        availDetails.forEach(function (svc) {
            t.equal(svc.length, 3, 'Service version and image');
            t.equal(foundSvcs.indexOf(svc[0]), -1, 'Duplicated service');
            foundSvcs.push(svc[0]);
        });
        t.end();
    });

});


test('sdcadm available --all-images', function (t) {
    exec('sdcadm available --all-images', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var availDetails = parseAvailOutput(t, stdout);
        availDetails.forEach(function (svc) {
            t.equal(svc.length, 3, 'Service version and image');
        });
        t.end();
    });

});


test('sdcadm avail -a manta', function (t) {
    exec('sdcadm avail -a manta', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var availDetails = parseAvailOutput(t, stdout);
        availDetails.forEach(function (svc) {
            t.equal(svc.length, 3, 'Service version and image');
        });
        t.end();
    });

});


test('sdcadm avail unknown', function (t) {
    exec('sdcadm avail unknown', function (err, stdout, stderr) {
        t.ok(err, 'Unknown service error');
        t.notEqual(stderr.indexOf(
                    'unknown SDC instance or service "unknown"'), -1);
        t.end();
    });

});


test('sdcadm avail --json', function (t) {
    exec('sdcadm avail --json', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var foundSvcs = [];
        var jsonDetails = common.parseJsonOut(stdout);
        jsonDetails.forEach(function (svc) {
            t.ok(svc.service, 'Service name');
            t.ok(svc.image, 'Available service Image');
            t.ok(svc.version, 'Available service version');
            t.equal(foundSvcs.indexOf(svc.service), -1, 'Duplicated service');
            foundSvcs.push(svc.service);
        });
        t.end();
    });

});
