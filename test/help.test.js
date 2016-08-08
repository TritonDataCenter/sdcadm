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
var checkHelp = require('./common').checkHelp;


test('sdcadm --help', function (t) {
    exec('sdcadm --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('sdcadm [OPTIONS] COMMAND [ARGS...]'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm help', function (t) {
    checkHelp(t, '', 'sdcadm help COMMAND');
});


test('sdcadm help self-update', function (t) {
    checkHelp(t, 'self-update', 'sdcadm self-update --latest [<options>]');
});


test('sdcadm help instances', function (t) {
    checkHelp(t, 'instances', 'sdcadm instances [<options>]');
});


test('sdcadm help insts', function (t) {
    checkHelp(t, 'insts', 'sdcadm instances [<options>]');
});


test('sdcadm help services', function (t) {
    checkHelp(t, 'services', 'sdcadm services [<options>]');
});


test('sdcadm help update', function (t) {
    checkHelp(t, 'update', 'sdcadm update [<options>]');
});


test('sdcadm help up', function (t) {
    checkHelp(t, 'up', 'sdcadm update [<options>]');
});


test('sdcadm help rollback', function (t) {
    checkHelp(t, 'rollback', 'sdcadm rollback [<options>]');
});


test('sdcadm help create', function (t) {
    checkHelp(t, 'create', 'sdcadm create <svc>');
});


test('sdcadm help check-config', function (t) {
    checkHelp(t, 'check-config', 'sdcadm check-config [<options>]');
});


test('sdcadm help check-health', function (t) {
    checkHelp(t, 'check-health', 'sdcadm check-health [<options>]');
});


test('sdcadm help post-setup', function (t) {
    checkHelp(t, 'post-setup', 'sdcadm post-setup [OPTIONS] COMMAND');
});


test('sdcadm help platform', function (t) {
    checkHelp(t, 'platform', 'sdcadm platform [OPTIONS] COMMAND');
});


test('sdcadm help experimental', function (t) {
    checkHelp(t, 'experimental', 'sdcadm experimental [OPTIONS] COMMAND');
});
