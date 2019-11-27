/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Data and utilty functions for handling the manta deployment zone
 * (the "manta" service on the "sdc" SAPI app).
 */

const assert = require('assert-plus');
const vasync = require('vasync');
const VError = require('verror');

const common = require('./common');
const errors = require('./errors');


// Also include older "manta-deployment" images to support usage
// through the transition period.
const MANTAV1_IMG_NAMES = ['mantav1-deployment', 'manta-deployment'];
const MANTAV2_IMG_NAMES = ['mantav2-deployment'];


// Dev Note: We cannot use `sdcadm.getApp` because we must use
// `include_master=true` for multi-DC manta.
function getMantaApp(sapi, cb) {
    sapi.listApplications({
        name: 'manta',
        include_master: 'true'
    }, function (err, apps) {
        if (err) {
            cb(new errors.SDCClientError(err, 'sapi'));
            return;
        }

        assert.ok(apps.length <= 1, 'zero or one "manta" SAPI apps');
        if (apps.length === 0) {
            cb(null, null);
        } else {
            cb(null, apps[0]);
        }
    });
}

// Get the current "mantav", the major version of the current Manta.
//
// This are three possible values:
// - `null` - There is no "manta" SAPI app in this region (set of linked DCs,
//   https://github.com/joyent/sdc-sapi/blob/master/docs/index.md#multi-dc-mode)
// - `1` - Either the `$mantaApp.metadata.MANTAV` is set to the number 1, or
//   it is not set.
// - `2` - `$mantaApp.metadata.MANTAV` is set to the number 2.
//
// Any other value results in this calling back with an error.
function getMantav(sdcadm, cb) {
    assert.object(sdcadm, 'sdcadm');
    assert.func(cb, 'cb');

    getMantaApp(sdcadm.sapi, function (err, app) {
        if (err) {
            cb(err);
        } else if (!app) {
            cb(null, null);
        } else {
            let mantav = app.metadata.mantav;
            if (mantav === undefined || mantav === 1) {
                cb(null, 1);
            } else if (mantav === 2) {
                cb(null, 2);
            } else {
                cb(new VError(
                    'invalid "metadata.MANTAV" on SAPI application %s ' +
                        '(manta), must be 1, 2, or undefined: %s',
                    app.uuid,
                    JSON.stringify(mantav)));
            }
        }
    });
}


// Determine the mantav based on the image used for a current manta deployment
// zone (an instance of the "manta" service on the "sdc" SAPI app), if there
// is one.
//
// Typically this is only called if `getMantav` could not determine a mantav,
// i.e. if there is no "manta" SAPI *app*.
//
// As with `getMantav()` there are the same three possible values:
// null, 1, or 2.
function getMantaDeploymentV(sdcadm, cb) {
    assert.object(sdcadm, 'sdcadm');
    assert.func(cb, 'cb');

    const context = {};
    const log = sdcadm.log;

    vasync.pipeline({
        arg: context,
        funcs: [
            sdcadm.ensureSdcApp.bind(sdcadm),

            function getCurrServerUuid(ctx, next) {
                sdcadm.getCurrServerUuid(function (err, currServerUuid) {
                    ctx.currServerUuid = currServerUuid;
                    next(err);
                });
            },

            // Dev Note: I'm avoiding using "SdcAdm.listInsts" because it (a)
            // does too much and then (b) throws away the image info we need.
            function getMantaSvc(ctx, next) {
                sdcadm.getSvc({
                    app: 'sdc',
                    svc: 'manta',
                    allowNone: true
                }, function (err, svc) {
                    if (err) {
                        next(err);
                    } else if (!svc) {
                        // No "manta" service, so there is no set version.
                        ctx.mantaDeploymentV = null;
                        next();
                    } else {
                        ctx.svc = svc;
                        next();
                    }
                });
            },

            function getMantaInst(ctx, next) {
                if (ctx.hasOwnProperty('mantaDeploymentV')) {
                    next();
                    return;
                }

                sdcadm.sapi.listInstances({
                    service_uuid: ctx.svc.uuid
                }, function onInsts(err, insts) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }

                    assert.ok(insts.length <= 1,
                        'there are multiple SAPI instances of service ' +
                        ctx.svc.uuid + ' (manta): ' + JSON.stringify(insts));
                    if (insts.length === 0) {
                        // No "manta" inst, so there is no set version.
                        ctx.mantaDeploymentV = null;
                    } else {
                        ctx.inst = insts[0];
                    }
                    next();
                });
            },

            function getMantaVm(ctx, next) {
                if (ctx.hasOwnProperty('mantaDeploymentV')) {
                    next();
                    return;
                }

                sdcadm.vmapi.getVm({uuid: ctx.inst.uuid}, function (err, vm) {
                    ctx.vm = vm;
                    next(err);
                });
            },

            // In general the image for a deployed VM could be removed from
            // IMGAPI. However, that image has to be on the zpool and we know
            // the manta zone has to be on the headnode, on which we are
            // running this sdcadm. So we can just call `imgadm get $uuid`.
            function getMantaImg(ctx, next) {
                if (ctx.hasOwnProperty('mantaDeploymentV')) {
                    next();
                    return;
                }

                assert.uuid(ctx.vm.image_uuid, 'vm ' + ctx.vm.uuid +
                    ' (' + ctx.vm.alias + ') has image_uuid');
                assert.equal(ctx.vm.server_uuid, ctx.currServerUuid,
                    'manta inst is on this server (the headnode): ' +
                    ctx.vm.server_uuid);

                common.spawnRun({
                    argv: ['/usr/sbin/imgadm', 'get', ctx.vm.image_uuid],
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(new VError(err,
                            'could not get image %s for manta vm %s',
                            ctx.vm.image_uuid, ctx.vm.uuid));
                        return;
                    }

                    const img = JSON.parse(stdout).manifest;
                    assert.string(img.name,
                        'manta image manifest has a name');
                    if (MANTAV1_IMG_NAMES.indexOf(img.name) !== -1) {
                        ctx.mantaDeploymentV = 1;
                        next();
                    } else if (MANTAV2_IMG_NAMES.indexOf(img.name) !== -1) {
                        ctx.mantaDeploymentV = 2;
                        next();
                    } else {
                        next(new VError('unexpected image name on manta ' +
                            'deployment vm %s: "%s"', ctx.vm.uuid, img.name));
                    }
                });
            }
        ]
    }, function finish(err) {
        if (err) {
            cb(err);
        } else {
            log.debug({mantaDeploymentV: context.mantaDeploymentV},
                'getMantaDeploymentV');
            cb(null, context.mantaDeploymentV);
        }
    });
}


// Determine the set of appropriate image names for the Manta deployment
// service.
//
// What image names to use depends on Manta state:
// - If there is already a "manta" SAPI application, that will tell use if this
//   is a mantav1 or a mantav2, then we return the appropriate image names for
//   that manta version.
// - Otherwise, if there is a manta deployment image provisioned (e.g. after a
//   run of `sdcadm post-setup manta`), then stick with the appropriate manta
//   version.
// - Otherwise, default to mantav2 image names.
function getImgNames(sdcadm, cb) {
    assert.object(sdcadm, 'sdcadm');
    assert.func(cb, 'cb');

    getMantav(sdcadm, function (mvErr, mantav) {
        if (mvErr) {
            cb(mvErr);
        } else if (mantav === 1) {
            cb(null, MANTAV1_IMG_NAMES);
        } else if (mantav === 2) {
            cb(null, MANTAV2_IMG_NAMES);
        } else {
            getMantaDeploymentV(sdcadm, function (mdvErr, mantaDeploymentV) {
                if (mdvErr) {
                    cb(mdvErr);
                } else if (mantaDeploymentV === 1) {
                    cb(null, MANTAV1_IMG_NAMES);
                } else if (mantaDeploymentV === 2) {
                    cb(null, MANTAV2_IMG_NAMES);
                } else {
                    // Default if no manta application and no manta deployment
                    // zone.
                    cb(null, MANTAV2_IMG_NAMES);
                }
            });
        }

    });
}


// --- exports

module.exports = {
    MANTAV1_IMG_NAMES: MANTAV1_IMG_NAMES,
    MANTAV2_IMG_NAMES: MANTAV2_IMG_NAMES,

    getMantav: getMantav,
    getImgNames: getImgNames
};
