/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Steps for setting the "no_rabbit=true" SDC config var:
 *    //JSSTYLED
 *    https://github.com/joyent/sdc/blob/master/docs/operator-guide/configuration.md#sdc-application-configuration
 */

var assert = require('assert-plus');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var errors = require('../errors');
var ur = require('../ur');


/**
 * This step is responsible for ensuring that the `no_rabbit` sapi config value
 * is set to true. This enables the newer Triton agents. To do this, first we
 * check to ensure that the `workflow` and `cnapi` are newer than a certain
 * threshold (release 20150917). While the switch is being enabled, we enable
 * datacenter maintenance mode, if it is not already enabled.
 */
function noRabbitEnable(arg, callback) {
    assert.object(arg, 'arg');
    assert.func(arg.progress, 'arg.progress');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.sdcApp, 'arg.sdcadm.sdcApp');
    var log = arg.log;
    var sdcadm = arg.sdcadm;
    var progress = arg.progress;

    var imgsFromSvcName = {};
    var MIN_NO_RABBIT_VERSION = '20150917';

    if (arg.sdcadm.sdcApp.metadata.no_rabbit) {
        log.debug({no_rabbit: arg.sdcadm.sdcApp.metadata.no_rabbit},
            'no_rabbit already enabled');
        callback();
        return;
    }

    progress('\n--- enable the new agents (no_rabbit=true)');

    vasync.pipeline({arg: {}, funcs: [
        function getVmImgs(_, next) {
            vasync.forEachParallel({
                inputs: ['cnapi', 'workflow'],
                func: function getServiceImg(vm, fenext) {
                    // get images for cnapi, workflow zones
                    sdcadm.getImgsForSvcVms({
                        svc: vm
                    }, function (err, obj) {
                        if (err) {
                            next(err);
                            return;
                        }
                        imgsFromSvcName[vm] = obj;
                        fenext();
                    });
                }
            }, next);
        },

        function checkMinVersions(_, next) {
            var notValidVersion = [];

            Object.keys(imgsFromSvcName).forEach(function (svcName) {
                progress('Checking "%s" is at least version %s', svcName,
                         MIN_NO_RABBIT_VERSION);
                var splitVersion =
                    imgsFromSvcName[svcName].imgs[0].version.split('-');
                var validVersion = false;

                if (splitVersion[0] === 'master') {
                    validVersion = splitVersion[1].substr(0, 8) >=
                        MIN_NO_RABBIT_VERSION;
                } else if (splitVersion[0] === 'release') {
                    validVersion = splitVersion[1] >= MIN_NO_RABBIT_VERSION;
                }

                if (!validVersion) {
                    notValidVersion.push([svcName, splitVersion[1]]);
                }
            });

            if (notValidVersion.length) {
                return next(new Error(util.format(
                    'Datacenter does not have the minimum version of %s ' +
                    'needed (%s, was %s) for enabling no_rabbit.\n' +
                    'Please try again after upgrading.',
                    notValidVersion[0][0],
                    MIN_NO_RABBIT_VERSION, notValidVersion[0][1])));
            }

            return next();
        },

        function checkMaintStatus(ctx, next) {
            sdcadm.dcMaintStatus(function (err, maintStatus) {
                if (err) {
                    next(err);
                } else {
                    ctx.maintStatus = maintStatus;
                    next();
                }
            });
        },
        function startDatacenterMaint(ctx, next) {
            if (ctx.maintStatus.maint) {
                next();
                return;
            }
            sdcadm.dcMaintStart({progress: progress}, next);
        },
        function updateSapiApplicationValue(_, next) {
            progress('Setting "no_rabbit=true" SDC config');
            progress('Warning: This changes other behaviour in the ' +
                'whole DC to use some new agents');
            var update = {
                metadata: {
                    no_rabbit: true
                }
            };
            sdcadm.sapi.updateApplication(sdcadm.sdcApp.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },
        function stopDatacenterMaint(ctx, next) {
            if (ctx.maintStatus.maint) {
                next();
                return;
            }
            sdcadm.dcMaintStop({progress: progress}, next);
        },
        function restartConfigAgentOnAllNodes(_, next) {
            progress('Restarting all GZ config-agent\'s for no_rabbit ' +
                'to propagate');
            ur.execOnAllNodes({
                sdcadm: sdcadm,
                cmd: '/usr/sbin/svcadm disable -s config-agent && ' +
                    '/usr/sbin/svcadm enable -s config-agent'
            }, next);
        },
        function waitForCnapiConfigAgents(_, next) {
            // Dev Note: sdcadm.listInsts returns the subset of objects. It
            // would be nice if it returned full VM objects so we don't have to
            // resort to VMAPI calls here.
            sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'cnapi',
                state: 'running',
                owner_uuid: sdcadm.config.ufds_admin_uuid
            }, function (vmsErr, cnapiVms) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                vasync.forEachParallel({
                    inputs: cnapiVms,
                    func: function updateCnapiConfig(vm, nextCnapi) {
                        progress('Restarting %s (vm %s) config-agent ' +
                            'for no_rabbit to propagate', vm.alias, vm.uuid);
                        ur.exec({
                            server: vm.server_uuid,
                            sdcadm: sdcadm,
                            cmd: format(
                                '/usr/sbin/svcadm -z %s disable -s ' +
                                'config-agent && /usr/sbin/svcadm ' +
                                '-z %s enable -s config-agent',
                                vm.uuid, vm.uuid)
                        }, nextCnapi);

                    }
                }, next);
            });
        }
    ]}, function (err) {
        callback(err);
    });
}


// --- exports

module.exports = {
    noRabbitEnable: noRabbitEnable
};

// vim: set softtabstop=4 shiftwidth=4:
