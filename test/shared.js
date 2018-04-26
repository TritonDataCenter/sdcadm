/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

/*
 * We want to be able to test some sdcadm subcommands (most of them part of
 * the post-setup subcommands) which are usually required before we can run
 * any other commands. If not used in a previous set of tests, these will run as
 * part of the post-setup test suite.
 */

var vasync = require('vasync');
var assert = require('assert-plus');

var exec = require('child_process').exec;
var common = require('./common');

// If there's an error here, the smarter thing to do is to just fail
// the whole process and avoid running any more tests, since those
// requiring IMGAPI external NIC will fail:
function haveCommonExternalNics(t, cb) {
    assert.func(cb, 'cb');
    var externalNicsExist = false;
    var cmd = 'sdc-vmapi /vms?query=\'(|(alias=adminui*)(alias=imgapi*))\'|' +
        'json -H';
    exec(cmd, function haveNicsCb(err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');
        var vms = common.parseJsonOut(stdout);
        vms = vms.filter(function alreadyHasExternalNic(vm) {
            return vm.nics.some(function (nic) {
                return nic.nic_tag === 'external';
            });
        });
        if (vms.length) {
            externalNicsExist = true;
        }
        cb(err, externalNicsExist);
    });
}

// TODO: check instances using either VMAPI or SAPI here so we can reach
// instances on other servers too.
function getNumInsts(svc, cb) {
    assert.string(svc, 'svc');
    assert.func(cb, 'cb');
    exec('vmadm lookup alias=~"^' + svc + '"', function lookupCb(err, stdout) {
        if (err) {
            cb(err);
            return;
        }
        var lines = stdout.split('\n').filter(function (l) {
            return (l !== '');
        });
        cb(null, lines.length);
    });
}


/*
 * `requirements` is expected to be an object including the following members:
 * {
 *      external_nics: true | false,
 *      cloudapi: true | false,
 *      docker: true | false
 * }
 */
function prepare(t, requirements) {
    assert.object(requirements, 'requirements');
    assert.optionalBool(requirements.external_nics,
        'requirements.external_nics');
    assert.optionalBool(requirements.cloudapi, 'requirements.cloudapi');
    assert.optionalBool(requirements.docker, 'requirements.docker');

    // We need to download images in order to be able to setup docker:
    if (requirements.docker) {
        requirements.external_nics = true;
    }
    vasync.pipeline({
        funcs: [
            function prepareExternalNics(_, next) {
                if (!requirements.external_nics) {
                    next();
                    return;
                }
                haveCommonExternalNics(t, function cb(err, externalNicsExist) {
                    if (err) {
                        next(err);
                        return;
                    }
                    if (externalNicsExist) {
                        next();
                        return;
                    }
                    var cmd = 'sdcadm post-setup common-external-nics';
                    exec(cmd, function execCb(err2, stdout, stderr) {
                        t.equal(stderr, '', 'Empty stderr');
                        next(err2);
                    });
                });
            },
            function prepareCloudapi(_, next) {
                if (!requirements.cloudapi) {
                    next();
                    return;
                }
                getNumInsts('cloudapi', function numInstsCb(err, numInsts) {
                    if (err) {
                        next(err);
                        return;
                    }
                    if (numInsts > 0) {
                        next();
                        return;
                    }
                    var cmd = 'sdcadm post-setup cloudapi';
                    exec(cmd, function execCb(err2, stdout, stderr) {
                        t.equal(stderr, '', 'Empty stderr');
                        next(err2);
                    });
                });
            },
            function prepareDocker(_, next) {
                if (!requirements.docker) {
                    next();
                    return;
                }
                getNumInsts('docker', function numInstsCb(err, numInsts) {
                    if (err) {
                        next(err);
                        return;
                    }
                    if (numInsts > 0) {
                        next();
                        return;
                    }
                    var cmd = 'sdcadm post-setup docker';
                    exec(cmd, function execCb(err2, stdout, stderr) {
                        t.equal(stderr, '', 'Empty stderr');
                        next(err2);
                    });
                });
            }
        ]
    }, function pipeCb(err) {
        t.end(err);
    });

}

module.exports = {
    haveCommonExternalNics: haveCommonExternalNics,
    getNumInsts: getNumInsts,
    prepare: prepare
};
// vim: set softtabstop=4 shiftwidth=4:
