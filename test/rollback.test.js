/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */


var test = require('tape').test;
var vasync = require('vasync');

var exec = require('child_process').exec;
var readdirSync = require('fs').readdirSync;
var util = require('util');

var common = require('./common');

var AVAILABLE_VERSION;
var ORIGINAL_VERSION;

var PAPI_SVC_UUID;
var PAPI_INSTANCE_UUID;

var SUCCESSFULLY_UPDATED = false;

var PLAN_PATH = ''; // filled in by setup

function getAvailableImage(cb) {
    exec('sdcadm avail papi --json', function execCb(err, stdout) {
        if (err) {
            cb(err);
            return;
        }

        var jsonDetails = common.parseJsonOut(stdout);
        if (!jsonDetails.length) {
            cb(null);
            return;
        }

        AVAILABLE_VERSION = jsonDetails[0].image;
        cb(null);
    });
}

function getPapiSvcUUID(cb) {
    var cmd = 'sdc-sapi /services?name=papi|json -H';
    exec(cmd, function execCb(err, stdout) {
        if (err) {
            cb(err);
            return;
        }

        PAPI_SVC_UUID = common.parseJsonOut(stdout)[0].uuid;
        cb(null);
    });
}


function getPapiInstanceUUID(cb) {
    var cmd = util.format('sdc-sapi /instances?service_uuid=%s | json -H',
            PAPI_SVC_UUID);
    exec(cmd, function execCb(err, stdout) {
        if (err) {
            cb(err);
            return;
        }

        var jsonDetails = common.parseJsonOut(stdout);
        PAPI_INSTANCE_UUID = jsonDetails[0].uuid;
        cb(null);
    });
}


function getPapiImageUUID(cb) {
    var cmd = util.format('sdc-vmapi /vms/%s | json -H',
            PAPI_INSTANCE_UUID);
    exec(cmd, function execCb(err, stdout) {
        if (err) {
            cb(err);
            return;
        }

        var jsonDetails = common.parseJsonOut(stdout);
        cb(null, jsonDetails.image_uuid);
    });
}


test('setup', function (t) {
    vasync.pipeline({
        funcs: [
            function (_, next) {
                getAvailableImage(function getAvailCb(err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    next();
                });
            },
            function (_, next) {
                getPapiSvcUUID(next);
            },
            function (_, next) {
                getPapiInstanceUUID(next);
            },
            function (_, next) {
                getPapiImageUUID(function (err, uuid) {
                    if (err) {
                        next(err);
                        return;
                    }

                    ORIGINAL_VERSION = uuid;
                    next();
                });
            },
            function (_, next) {
                if (!AVAILABLE_VERSION) {
                    next();
                    return;
                }
                var cmd = 'sdcadm update papi --yes';

                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err);

                    t.ok(stdout.match('Updated successfully'));
                    t.equal(stderr, '');

                    var update = readdirSync('/var/sdcadm/updates').pop();
                    t.ok(update);
                    PLAN_PATH = '/var/sdcadm/updates/' + update + '/plan.json';
                    SUCCESSFULLY_UPDATED = true;
                    next();
                });

            }
        ]
    }, function (resErr) {
        t.ifError(resErr);
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
    if (!SUCCESSFULLY_UPDATED) {
        t.end();
        return;
    }
    var cmd = 'sdcadm rollback -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.ok(stderr.match('dependencies not implemented'));

        t.end();
    });
});


test('sdcadm rollback --dry-run -f', function (t) {
    if (!SUCCESSFULLY_UPDATED) {
        t.end();
        return;
    }
    var cmd = 'sdcadm rollback --dry-run -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.ok(stderr.match('dependencies not implemented.'));

        t.end();
    });
});


test('sdcadm rollback --dry-run --force --yes -f', function (t) {
    if (!SUCCESSFULLY_UPDATED) {
        t.end();
        return;
    }
    var cmd = 'sdcadm rollback --dry-run --yes --force -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('rollback "papi" service to image'));
        t.ok(stdout.match('Rolledback successfully'));

        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm rollback --force --yes -f', function (t) {
    if (!SUCCESSFULLY_UPDATED) {
        t.end();
        return;
    }
    var cmd = 'sdcadm rollback --force --yes -f ' + PLAN_PATH;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('rollback "papi" service to image'));
        t.ok(stdout.match('Rolledback successfully'));

        t.equal(stderr, '');

        exec('vmadm list | grep papi', function execCb(err2, stdout2) {
            t.ifError(err2);

            stdout2.split('\n').forEach(function (line) {
                if (line !== '') {
                    t.ok(line.match('running'));
                }
            });

            getPapiImageUUID(function (err3, uuid) {
                t.ifError(err3);
                t.equal(ORIGINAL_VERSION, uuid);

                t.end();

            });
        });
    });
});


test('teardown', function (t) {
    if (!SUCCESSFULLY_UPDATED) {
        t.end();
        return;
    }
    var cmd = util.format('sdc-imgadm delete %s', AVAILABLE_VERSION);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var str = util.format('Deleted image %s', AVAILABLE_VERSION);
        t.notEqual(stdout.indexOf(str), -1, 'check image deleted');
        t.end();
    });
});
