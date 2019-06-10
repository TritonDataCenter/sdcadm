/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The collection of "procedure" functions that know how to perform part of
 * an update plan (i.e. for `sdcadm update`).
 */

var assert = require('assert-plus');
var netconfig = require('triton-netconfig');
var os = require('os');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var VError = require('verror');

var common = require('../common');
var errors = require('../errors'),
    UpdateError = errors.UpdateError,
    UsageError = errors.UsageError;

// --- HA ready services

// Here "SIMPLE" means those that can be upgraded with the
// UpdateStatelessServices.
var HA_READY_SIMPLE_SVCS = [
    'adminui',
    'cloudapi',
    'cmon',
    'mahi',
    'nat',
    'papi',
    'portolan',
    'workflow'
];
var ALL_HA_READY_SVCS = HA_READY_SIMPLE_SVCS.concat([
    'moray'
]);


// --- From this version, SAPI can be updated w/o using a temporary instance:
var FIRST_NON_CIRCULAR_SAPI_VERSION = '20180622T144529Z';
var FIRST_NON_CIRCULAR_SAPI_RELEASE_DATE = '20180705';

// --- internal support stuff

function NoOp() {}
NoOp.prototype.summarize = function noOpSummarize() {
    return 'no-op';
};
NoOp.prototype.execute = function noOpExecute(_options, cb) {
    cb();
};



// --- procedures from the modules where we've defined them:
var DownloadImages = require('./download-images').DownloadImages;
var UpdateStatelessServices =
    require('./update-stateless-services-v1').UpdateStatelessServices;
var UpdateSingleHeadnodeImgapi =
    require('./update-single-headnode-imgapi').UpdateSingleHeadnodeImgapi;
var UpdateMorayV2 = require('./update-moray-v2').UpdateMorayV2;
var UpdateSingleHNSapiV1 =
    require('./update-single-hn-sapi-v1').UpdateSingleHNSapiV1;
// --- New SAPI versions w/o circular dependencies with itself for updates:
var UpdateSapiV2 = require('./update-sapi-v2').UpdateSapiV2;
var UpdateManateeV2 = require('./update-manatee-v2').UpdateManateeV2;
var UpdateBinderV2 = require('./update-binder-v2').UpdateBinderV2;
// --- Create service instance also from procedures:
var CreateServiceInstanceV1 =
require('./create-service-instance-v1').CreateServiceInstanceV1;
// --- Individual agent services update:
var UpdateAgentV1 = require('./update-agent-v1').UpdateAgentV1;
// --- Dockerlogger service:
var UpdateDockerlogger = require('./update-dockerlogger').UpdateDockerlogger;

/**
 * This is the function that determines *how* we are going to update.
 *
 * Returns an array of procedure objects that will (in-order) handle the
 * full given update plan. This will error out if the plan cannot be
 * handled (i.e. if this tool doesn't know how to update something yet).
 *
 * @param opts {Object}  Required.
 *      - plan {UpdatePlan} Required.
 *      - log {Bunyan Logger} Required.
 *      - serverFromUuidOrHostname {Object} Required.
 * @param cb {Function} Callback of the form `function (err, procs)`.
 */
function coordinatePlan(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.optionalFunc(opts.progress, 'opts.progress');
    assert.object(opts.serverFromUuidOrHostname,
        'opts.serverFromUuidOrHostname');
    assert.optionalBool(opts.noVerbose, 'opts.noVerbose');
    assert.optionalArrayOfString(opts.servers, 'opts.servers');
    assert.optionalBool(opts.justAvailable, 'opts.justAvailable');
    assert.func(cb, 'cb');

    var log = opts.log;
    var progress = opts.progress || function () {};
    var sdcadm = opts.sdcadm;
    var forceSameImage = opts.plan.forceSameImage;
    var instsFromSvcName = {};
    var insts = opts.plan.curr;
    for (var i = 0; i < insts.length; i++) {
        var inst = insts[i];
        var svcName = inst.service;
        if (!instsFromSvcName[svcName]) {
            instsFromSvcName[svcName] = [];
        }
        instsFromSvcName[svcName].push(inst);
    }

    var changes = opts.plan.changes.slice();
    var procs = [];
    vasync.pipeline({funcs: [
        /**
         * If SAPI isn't in full mode, we'll error out and stop the updates
         */
        function ensureSapiFullMode(_, next) {
            sdcadm.sapi.getMode(function getModeCb(err, mode) {
                if (err) {
                    next(err);
                    return;
                }

                if (mode !== 'full') {
                    var msg = 'SAPI is not in full mode. ' +
                        'This could mean initial setup failed. ' +
                        'Please fix SAPI VMs before continue:\n' +
                        '   `sdc-sapi /mode?mode=full -X POST`';
                    next(new errors.UpdateError(new Error(msg), 'sapi'));
                    return;
                }
                next();
            });
        },
        /**
         * Add the procedure for downloading images (from updates.joyent.com),
         * if necessary.
         */
        function coordImages(_, next) {
            var imageFromUuid = {};
            for (var c = 0; c < changes.length; c++) {
                var img = changes[c].image;
                if (img) {
                    imageFromUuid[img.uuid] = img;
                }
            }
            var images = Object.keys(imageFromUuid).map(
                function (uuid) { return imageFromUuid[uuid]; });
            var imagesToRetrieve = [];
            vasync.forEachParallel({
                inputs: images,
                func: function imageExists(image, nextImage) {
                    sdcadm.imgapi.getImage(image.uuid, function (err, local) {
                        if (err && err.body.code === 'ResourceNotFound') {
                            imagesToRetrieve.push(image);
                            nextImage();
                        } else if (err) {
                            nextImage(new errors.SDCClientError(err, 'imgapi'));
                        } else {
                            if (local.state === 'unactivated') {
                                // Let DownloadImages know that it has to
                                // remove the image first:
                                image.state = 'unactivated';
                                imagesToRetrieve.push(image);
                            }
                            nextImage();
                        }
                    });
                }
            }, function (err) {
                if (err) {
                    next(err);
                    return;
                }
                if (imagesToRetrieve.length > 0) {
                    procs.push(new DownloadImages({
                        images: imagesToRetrieve
                    }));
                }
                next();
            });
        },

        /**
         * Update services that are stateless with no current special handling
         * (like migrations).
         */
        function updateSimpleServices(_, next) {
            var simpleServices = [
                'amon', 'amonredis', 'assets', 'cnapi', 'cns', 'dhcpd',
                'docker', 'fwapi', 'grafana', 'kbmapi', 'logarchiver', 'manta',
                'napi', 'prometheus', 'rabbitmq', 'redis', 'sdc', 'ufds',
                'vmapi', 'volapi'
            ].concat(HA_READY_SIMPLE_SVCS);
            var handle = [];
            var remaining = [];
            var errs = [];
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    ~simpleServices.indexOf(change.service.name)) {
                    if (opts.servers && opts.servers.length &&
                        opts.servers.indexOf(change.instance.server) === -1) {
                        errs.push(new UpdateError(format(
                            'Instance "%s" is not on server(s) "%s"',
                            change.instance.instance,
                            opts.servers.join(', '))));
                    } else {
                        change.inst = change.instance;
                        handle.push(change);
                    }
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    ~simpleServices.indexOf(change.service.name)) {
                    if (svcInsts.length === 0) {
                        log.debug({
                                numInsts: 0,
                                svc: change.service.name
                            }, 'UpdateStatelessServices update service ' +
                            'with no instance');

                        if (!opts.noVerbose) {
                            progress('Note: There are no "%s" instances. ' +
                                'Only the service configuration will be ' +
                                'updated.', change.service.name);
                        }
                        // Push an instance-less service update
                        handle.push(change);
                    } else if (svcInsts.length !== 1) {
                        if (opts.justAvailable) {
                            change.insts = svcInsts;
                            handle.push(change);
                        } else {
                            if (~HA_READY_SIMPLE_SVCS.indexOf(
                                change.service.name)) {
                                var chInsts = forceSameImage ? svcInsts :
                                        svcInsts.filter(function (ins) {
                                            return (ins.image !==
                                                change.image.uuid);
                                        });
                                change.insts = chInsts;
                                handle.push(change);
                            } else {
                                log.debug({
                                        numInsts: svcInsts.length,
                                        svc: change.service.name
                                    }, 'UpdateStatelessServices skip change: ' +
                                    'not 1 inst');
                            }
                        }
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateStatelessServices will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateStatelessServices({
                    changes: handle
                }));
            }
            next(VError.errorFromList(errs));
        },

        function updateSingleHeadnodeImgapi(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    change.service.name === 'imgapi') {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'imgapi') {
                    if (svcInsts.length !== 1) {
                        if (opts.justAvailable) {
                            change.insts = svcInsts;
                            handle.push(change);
                        } else {
                            log.debug({
                                    numInsts: svcInsts.length,
                                    svc: change.service.name
                                }, 'UpdateSingleHeadnodeImgapi skip change: ' +
                                'not 1 inst');
                        }
                    } else if (svcInsts[0].hostname !== currHostname) {
                        if (opts.justAvailable) {
                            change.inst = svcInsts[0];
                            handle.push(change);
                        } else {
                            log.debug({
                                    svc: change.service.name,
                                    cn: svcInsts[0].server
                                }, 'UpdateSingleHeadnodeImgapi skip change: ' +
                                'inst not on headnode');
                        }
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateSingleHeadnodeImgapi will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateSingleHeadnodeImgapi({
                    changes: handle
                }));
            }
            next();
        },

        // Moving to full HA update. It shouldn't matter where each VM is
        // running:
        function updateMorays(_, next) {
            var handle = [];
            var remaining = [];
            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'moray') {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'moray') {
                    var svcInsts = instsFromSvcName[change.service.name] || [];
                    if (svcInsts.length && svcInsts.length > 1) {
                        var chInsts = forceSameImage ? svcInsts :
                                svcInsts.filter(function (ins) {
                                    return (ins.image !==
                                        change.image.uuid);
                                });
                        change.insts = chInsts;
                    } else {
                        change.inst = svcInsts[0];
                    }
                    handle.push(change);
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'updateMorays will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateMorayV2({
                    changes: handle
                }));
            }
            next();
        },

        function updateSingleHeadnodeSapi(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            var badState = false;
            changes.forEach(function (change) {
                var parts = change.image.version.split('-');
                if (parts.length && parts.length > 2) {
                    if (parts[0] === 'release') {
                        var curVer = parts[1];
                        if (curVer >= FIRST_NON_CIRCULAR_SAPI_RELEASE_DATE) {
                            remaining.push(change);
                            return;
                        }
                    } else {
                        var curStamp = parts[parts.length - 2];
                        if (curStamp >= FIRST_NON_CIRCULAR_SAPI_VERSION) {
                            remaining.push(change);
                            return;
                        }
                    }
                }
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    change.service.name === 'sapi') {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'sapi') {
                    if (svcInsts.length !== 1) {
                        // If we have a sapi0tmp instance we have not been able
                        // to remove on a previous upgrade attempt, let's tell
                        // the user about it with a clear message:
                        var sapiRunning;
                        var sapiInst, sapiTmpInst;
                        svcInsts.forEach(function (ins) {
                            if (ins.alias === 'sapi0tmp') {
                                sapiTmpInst = ins;
                            } else {
                                sapiRunning = (ins.state === 'running');
                                sapiInst = ins;
                            }
                        });

                        var msg = [];
                        msg.push('Please resolve these issues before ' +
                                'attempting SAPI upgrades:');

                        if (!sapiRunning) {
                            msg.push(common.indent(format(
                                '- SAPI instance %s (%s) is not running.',
                                sapiInst.zonename,
                                sapiInst.alias)));
                        }
                        msg.push(common.indent(format(
                            '- Temporary SAPI instance %s (%s)\n' +
                            'created by a previous update has not been ' +
                            'removed from the system.',
                            sapiTmpInst.zonename,
                            sapiTmpInst.alias)));

                        progress('');
                        progress(msg.join('\n'));
                        progress('');

                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateSingleHNSapiV1 skip change: ' +
                            'not 1 inst');

                        badState = true;
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateSingleHNSapiV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateSingleHNSapiV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateSingleHNSapiV1({
                    changes: handle
                }));
            }

            if (badState) {
                next(new errors.InternalError({
                    message: 'Unexpected state for SAPI service instances'
                }));
            } else {
                next();
            }
        },

        /**
         * Starting with FIRST_NON_CIRCULAR_SAPI_VERSION we can update SAPI
         * w/o going through a temporary instance, w/o caring about HA
         */
        function updateSapi(_, next) {
            var handle = [];
            var remaining = [];
            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'sapi') {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'sapi') {
                    var svcInsts = instsFromSvcName[change.service.name] || [];
                    if (svcInsts.length) {
                        if (svcInsts.length > 1) {
                            var chInsts = forceSameImage ? svcInsts :
                                    svcInsts.filter(function (ins) {
                                        return (ins.image !==
                                            change.image.uuid);
                                    });
                            change.insts = chInsts;
                        } else {
                            change.inst = svcInsts[0];
                        }
                    }
                    handle.push(change);
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'updateSapi will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateSapiV2({
                    changes: handle
                }));
            }
            next();

        },

        /**
         * Manatee service upgrade.
         * Note we assume there's at least one manatee on the server from where
         * we are performing the upgrade.
         */
        function updateManatees(_, next) {
            var handle = [];
            var remaining = [];
            var errs = [];
            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'manatee') {
                    errs.push(new UpdateError('Individual update of manatee' +
                        ' instances is not allowed'));
                    return;
                }

                if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'manatee') {
                    // Note this is completely different than "single" and
                    // in "HN" functions above. For manatee, we'll try to
                    // update all of them, despite of the server they're
                    // into:
                    var svcInsts = instsFromSvcName[change.service.name] || [];
                    if (svcInsts.length && svcInsts.length > 1) {
                        change.insts = svcInsts;
                    } else {
                        change.inst = svcInsts[0];
                    }
                    handle.push(change);
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'updateManatees will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateManateeV2({
                    changes: handle
                }));
            }
            next(VError.errorFromList(errs));
        },

        function updateBinder(_, next) {
            var handle = [];
            var remaining = [];
            var errs = [];
            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'binder') {
                    if (opts.servers && opts.servers.length &&
                        opts.servers.indexOf(change.instance.server) === -1) {
                        errs.push(new UpdateError(format(
                            'Instance "%s" is not on server(s) "%s"',
                            change.instance.instance,
                            opts.servers.join(', '))));
                    } else {
                        change.inst = change.instance;
                        handle.push(change);
                    }
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'binder') {
                    var svcInsts = instsFromSvcName[change.service.name] || [];
                    if (svcInsts.length && svcInsts.length > 1) {
                        var chInsts = forceSameImage ? svcInsts :
                                svcInsts.filter(function (ins) {
                                    return (ins.image !==
                                        change.image.uuid);
                                });
                        change.insts = chInsts;
                    } else {
                        change.inst = svcInsts[0];
                    }
                    handle.push(change);

                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateBinderV2 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateBinderV2({ changes: handle }));
            }
            next(VError.errorFromList(errs));
        },


        /**
         * Create simple service instances. It's to say, do not create those
         * instances which require special configuration like 2nd manatee,
         * (handled by post-setup ha-manatee) or binder instances, (handled
         * by post-setup ha-binder).
         *
         * Note that the nature of the create command makes it reach this
         * point with a single change, even when we keep this function using
         * arrays for consistency with the design for upgrades.
         */
        function createServiceInstance(_, next) {
            // Any instance which should never be created using
            // this tool should be here:
            var avoid = ['binder', 'manatee', 'rabbitmq', 'zookeeper'];

            var handle = [];
            var remaining = [];
            var err;

            function processChange(change, nextChange) {
                if (change.type !== 'create-instances' ||
                    change.service.type !== 'vm') {
                    remaining.push(change);
                    return nextChange();
                }

                var sName = change.service.name;
                var allowed = ((avoid.indexOf(sName) === -1) &&
                    (ALL_HA_READY_SVCS.indexOf(sName) !== -1 ||
                        change.force));

                if (allowed) {
                    log.debug({
                        numInsts: change.servers.length,
                        svc: sName,
                        servers: change.servers
                    }, 'CreateServiceIntanceV1 create service ' +
                    'additional instances');
                    handle.push(change);
                } else {
                    if (avoid.indexOf(sName) === -1) {
                        err = new UsageError(format(
                            'The "%s" service does not support proper ' +
                            'operation with multiple instances. Running ' +
                            'multiple instances is unsupported.\n(For ' +
                            'development of Triton, this guard can be ' +
                            'skipped with ' +
                            '"--dev-allow-multiple-instances")',
                            sName));
                    } else {
                        remaining.push(change);
                    }
                }

                return nextChange();

            }

            vasync.forEachPipeline({
                func: processChange,
                inputs: changes
            }, function () {
                if (handle.length) {
                    changes = remaining;
                    log.debug({changes: handle},
                        'CreateServiceIntanceV1 will handle %d change(s)',
                        handle.length);
                    procs.push(new CreateServiceInstanceV1({
                        changes: handle
                    }));
                }
                next(err);

            });
        },

        /**
         * Update individual agent instances
         */
        function updateAgent(_, next) {
            var errs = [];
            // Names of the agents which can be updated using this method:
            var allowed = ['cn-agent', 'vm-agent', 'net-agent',
                'agents_core', 'firewaller', 'smartlogin', 'config-agent',
                'amon-agent', 'amon-relay', 'hagfish-watcher',
                'cmon-agent', 'firewall-logger-agent'
            ];

            var handle = [];
            var remaining = [];

            // Make sure we get a list of uuids even if hostnames may be
            // initially present as servers option:
            if (opts.servers && opts.servers.length) {
                var notFound = opts.servers.filter(function (s) {
                    return (!opts.serverFromUuidOrHostname[s]);
                });
                if (notFound.length) {
                    next(new errors.UpdateError(format(
                            'unknown servers "%s"', notFound.join('", "'))));
                    return;
                }
                opts.servers = opts.servers.map(function (s) {
                    return opts.serverFromUuidOrHostname[s].uuid;
                });
            }

            changes.forEach(function (change) {
                if ((change.type !== 'update-service' &&
                    change.type !== 'update-instance') ||
                    change.service.type !== 'agent' ||
                    change.service.name === 'dockerlogger') {
                    remaining.push(change);
                    return;
                }

                var svcInsts = [];
                if (change.type === 'update-service') {
                    if (opts.servers && opts.servers.length) {
                        change.type = 'update-instances';
                    }
                    svcInsts = instsFromSvcName[change.service.name] || [];
                    // If we have a given set of servers, just filter instances
                    // present on the given list:
                    if (opts.servers && opts.servers.length) {
                        svcInsts = svcInsts.filter(function (ins) {
                            return (opts.servers.indexOf(ins.server) !== -1);
                        });
                    }
                } else if (change.instance) {
                    if (opts.servers && opts.servers.length &&
                        opts.servers.indexOf(change.instance.server) === -1) {
                        errs.push(new UpdateError(format(
                            'Instance "%s" is not on server(s) "%s"',
                            change.instance.instance,
                            opts.servers.join(', '))));
                    } else {
                        svcInsts = [change.instance];
                    }
                }

                if (allowed.indexOf(change.service.name) !== -1) {
                    change.insts = svcInsts;
                    log.debug({
                        numInsts: svcInsts.length,
                        svc: change.service.name,
                        server: change.server
                    }, 'UpdateAgentV1');
                    handle.push(change);
                } else {
                    // TODO: `sdcadm update agents` as a shortcut to update all
                    // the allowed agents
                    remaining.push(change);
                }
            });

            if (handle.length) {
                changes = remaining;
                // Do not add the procedure in case we're updating an agent
                // not setup yet:
                handle = handle.filter(function (h) {
                    return (h.insts.length);
                });

                if (handle.length) {
                    log.debug({
                        changes: handle
                    }, 'UpdateAgentV1 will handle %d change(s)', handle.length);

                    procs.push(new UpdateAgentV1({
                        changes: handle
                    }));
                }

            }
            next(VError.errorFromList(errs));
        },

        function dockerLogger(_, next) {
            var handle = [];
            var remaining = [];
            var errs = [];

            // Make sure we get a list of uuids even if hostnames may be
            // initially present as servers option:
            if (opts.servers && opts.servers.length) {
                opts.servers = opts.servers.map(function (s) {
                    return opts.serverFromUuidOrHostname[s].uuid;
                });
            }

            changes.forEach(function (change) {
                if (change.service.name !== 'dockerlogger' ||
                    change.type === 'create-instances') {
                    remaining.push(change);
                    return;
                }

                var svcInsts = [];
                if (change.type === 'update-service') {
                    svcInsts = instsFromSvcName[change.service.name] || [];
                    // If we have a given set of servers, just filter instances
                    // present on the given list:
                    if (opts.servers && opts.servers.length) {
                        svcInsts = svcInsts.filter(function (ins) {
                            return (opts.servers.indexOf(ins.server) !== -1);
                        });
                    }
                } else if (change.instance) {
                    if (opts.servers && opts.servers.length &&
                        opts.servers.indexOf(change.instance.server) === -1) {
                        errs.push(new UpdateError(format(
                            'Instance "%s" is not on server(s) "%s"',
                            change.instance.instance,
                            opts.servers.join(', '))));
                    } else {
                        svcInsts = [change.instance];
                    }
                }

                change.insts = svcInsts;
                log.debug({
                    numInsts: svcInsts.length,
                    svc: change.service.name,
                    server: change.server
                }, 'UpdateDockerlogger');
                handle.push(change);
            });

            if (handle.length) {
                changes = remaining;
                log.debug({
                    changes: handle
                },
                'UpdateDockerlogger will handle %d change(s)', handle.length);

                procs.push(new UpdateDockerlogger({
                    changes: handle
                }));
            }
            next(VError.errorFromList(errs));
        },

        function createAgentInstance(_, next) {
            var handle = [];
            var handleDockerlogger = [];
            var remaining = [];
            var errs = [];


            function processChange(change, nextChange) {
                if (change.type !== 'create-instances' ||
                    change.service.type !== 'agent') {
                    remaining.push(change);
                    nextChange();
                    return;
                }

                var arg = {
                    insts: [],
                    serverFromUuidOrHostname: opts.serverFromUuidOrHostname
                };
                vasync.pipeline({
                    arg: arg,
                    funcs: [
                        function loadDockerloggerInstsServers(ctx, nextStep) {
                            if (change.service.name !== 'dockerlogger') {
                                nextStep();
                                return;
                            }
                            sdcadm.sapi.listInstances({
                                service_uuid: change.service.uuid
                            }, function (sapiErr, sapiInsts) {
                                if (sapiErr) {
                                    errs.push(new errors.SDCClientError(
                                        sapiErr, 'sapi'));
                                    nextStep();
                                    return;
                                }
                                var servers = sapiInsts.map(function (sIns) {
                                    return sIns.params ?
                                        sIns.params.server_uuid : null;
                                }).filter(function (srv) {
                                    return srv !== null;
                                });

                                ctx.dockerInstServers = servers;
                                nextStep();
                            });
                        },
                        function filterDockerLoggerInsts(ctx, nextStep) {
                            if (change.service.name !== 'dockerlogger') {
                                nextStep();
                                return;
                            }
                            change.servers.forEach(function (server) {
                                var s = ctx.serverFromUuidOrHostname[server];
                                if (ctx.dockerInstServers.indexOf(
                                    s.uuid) !== -1) {
                                    errs.push(new errors.UsageError(format(
                                        'Agent "%s" instance already exists ' +
                                        'on server "%s".',
                                        change.service.name, server)));
                                    return;
                                }
                                ctx.insts.push({
                                    type: change.service.type,
                                    service: change.service.name,
                                    image: change.image.uuid,
                                    server: s.uuid,
                                    hostname: s.hostname,
                                    server_ip: netconfig.adminIpFromSysinfo(
                                        s.sysinfo),
                                    instance: null,
                                    version: change.image.version
                                });
                            });
                            nextStep();
                        },
                        function filterAgentInstances(ctx, nextStep) {
                            if (change.service.name === 'dockerlogger') {
                                nextStep();
                                return;
                            }
                            change.servers.forEach(function (server) {
                                var s = ctx.serverFromUuidOrHostname[server];
                                var installedAgents = s.agents.map(
                                    function (a) {
                                    return a.name;
                                });

                                if (installedAgents.indexOf(
                                    change.service.name) !== -1) {
                                    errs.push(new errors.UsageError(format(
                                            'Agent "%s" instance already ' +
                                            'exists on server "%s".',
                                            change.service.name, server)));
                                    return;
                                }
                                ctx.insts.push({
                                    type: change.service.type,
                                    service: change.service.name,
                                    image: change.image.uuid,
                                    server: s.uuid,
                                    hostname: s.hostname,
                                    server_ip: netconfig.adminIpFromSysinfo(
                                        s.sysinfo),
                                    instance: null,
                                    version: change.image.version
                                });
                            });
                            nextStep();
                        },
                        function removeDuplicates(ctx, nextStep) {
                            var svcs = {};
                            var duplicates = null;
                            ctx.insts.forEach(function (ins) {
                                if (!svcs[ins.service]) {
                                    svcs[ins.service] = [ins.server];
                                } else if (
                                    svcs[ins.service]
                                    .indexOf(ins.server) !== -1) {
                                    duplicates = true;
                                    errs.push(new errors.UsageError(format(
                                        'Duplicated server "%s" for service ' +
                                        '"%s"', ins.server, ins.service)));
                                }
                            });
                            nextStep(duplicates);
                        }
                    ]
                }, function pipeCb(pipeErr) {
                    if (!arg.insts.length || pipeErr) {
                        remaining.push(change);
                    } else {
                        change.insts = arg.insts;
                        if (change.service.name === 'dockerlogger') {
                            handleDockerlogger.push(change);
                        } else {
                            handle.push(change);
                        }
                    }
                    nextChange();
                });
            }

            vasync.forEachPipeline({
                func: processChange,
                inputs: changes
            }, function () {
                if (handle.length) {
                    changes = remaining;
                    log.debug({changes: handle},
                        'UpdateAgentV1 will handle %d change(s)',
                        handle.length);

                    procs.push(new UpdateAgentV1({
                        changes: handle
                    }));
                } else if (handleDockerlogger.length) {
                    changes = remaining;
                    log.debug({changes: handle},
                        'UpdateDockerlogger will handle %d change(s)',
                        handle.length);
                    procs.push(new UpdateDockerlogger({
                        changes: handleDockerlogger
                    }));
                }
                next(VError.errorFromList(errs));
            });
        },

        function sdcadmAvailable(_, next) {
            var remaining = [];
            // Just ignore sdcadm for now
            changes.forEach(function (change) {
                if (change.service.name !== 'sdcadm') {
                    remaining.push(change);
                }
            });
            changes = remaining;
            next();
        }

        // TODO: last is to purge unused core images (housekeeping)
        //      Plan: if can, add a marker (tag?) to images imported by
        //      'sdcadm' so know that we can feel more confident removing
        //      these ones. Can't think of current use cases for not
        //      purging images. Add a boolean config to not do this at all.
        //      Add a separate 'sdcadm purge-images/cleanup-images' or
        //      something.
        // TODO: Also purge older unused images *on the CN zpools*.
    ]}, function done(err) {
        if (err) {
            cb(err);
        } else if (changes.length) {
            // 'sdcadm' special case until it's not a proper SAPI service:
            var summary = changes
                .map(function (c) {
                    var sum = {};
                    if (c.type) { sum.type = c.type; }
                    if (c.service) { sum.service = c.service.name; }
                    if (c.image) { sum.image = c.image.uuid; }
                    return sum;
                })
                .map(function (c) { return JSON.stringify(c); })
                .join('\n    ');
            cb(new UpdateError(
                'do not support the following changes:\n    ' + summary));
        } else {
            if (opts.plan.justImages) {
                procs = procs.filter(function (proc) {
                    return proc.constructor.name === 'DownloadImages';
                });
            }
            cb(null, procs);
        }
    });
}


/*
 * Appropriately run a given array of Procedure instances. This involves
 * acquiring the sdcadm lock, running each procedure's "prepare", filtering
 * out procedures that have "nothingToDo", summarizing, getting confirmation,
 * executing, and reporting completion/error.
 *
 * Dev Note: Eventually `sdcadm update` ("do_update.js", `sdcadm.summarizePlan`,
 * etc.) should use this, but currently it does not.
 */
function runProcs(opts, cb) {
    assert.arrayOfObject(opts.procs, 'opts.procs');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.optionalBool(opts.skipConfirm, 'opts.skipConfirm');
    assert.optionalBool(opts.dryRun, 'opts.dryRun');

    var log = opts.log;
    var p = opts.ui.progressFunc();
    var sdcadm = opts.sdcadm;
    var ui = opts.ui;
    var context = {
        procs: opts.procs
    };

    vasync.pipeline({arg: context, funcs: [
        function getLock(ctx, next) {
            sdcadm.acquireLock({
                progress: p
            }, function (lockErr, unlock) {
                ctx.unlock = unlock;
                next(lockErr);
            });
        },

        // `prepare()` each procedure and filter out those that have
        // "nothingToDo".
        function prepareProcs(ctx, next) {
            vasync.forEachParallel({
                inputs: ctx.procs,
                func: function prepareProc(proc, nextProc) {
                    log.debug({procName: proc.constructor.name}, 'prepareProc');
                    proc.prepare({
                        sdcadm: sdcadm,
                        ui: ui,
                        log: log
                    }, function preparedProc(err, nothingToDo) {
                        if (err) {
                            nextProc(err);
                        } else {
                            proc._nothingToDo = Boolean(nothingToDo);
                            if (proc._nothingToDo) {
                                log.debug({procName: proc.constructor.name},
                                    'proc has nothingToDo');
                            }
                            nextProc();
                        }
                    });
                }
            }, function (err) {
                if (err) {
                    next(common.flattenMultiError(err));
                } else {
                    // Filter out procs with nothing to do.
                    ctx.procs = ctx.procs.filter(proc => !proc._nothingToDo);
                    next();
                }
            });
        },

        function confirm(ctx, next) {
            if (ctx.procs.length === 0) {
                ui.info('');
                ui.info('Nothing to do.');
                next(true); // Early abort.
                return;
            }

            ui.info('');
            ui.info('This will make the following changes:');
            for (let proc of ctx.procs) {
                ui.info(common.indent(proc.summarize()));
            }
            ui.info('');
            if (opts.skipConfirm) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    ui.info('Aborting.');
                    next(true);
                    return;
                }
                ui.info('');
                next();
            });
        },

        function exec(ctx, next) {
            ctx.execStart = Date.now();
            if (opts.dryRun) {
                ui.info('Skipping execution (dry-run).');
                next();
                return;
            }
            vasync.forEachPipeline({
                inputs: ctx.procs,
                func: function execProc(proc, nextProc) {
                    log.debug({summary: proc.summarize()}, 'execProc');
                    proc.execute({
                        sdcadm: sdcadm,
                        // The `progress` arg is deprecated. Procs should switch
                        // to `ui`.
                        progress: p,
                        ui: ui,
                        log: log
                    }, nextProc);
                }
            }, next);
        }
    ]}, function finishUp(runErr) {
        // Early abort signal.
        if (runErr === true) {
            runErr = null;
        }

        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!context.unlock) {
                    next();
                    return;
                }
                sdcadm.releaseLock({unlock: context.unlock}, next);
            }
        ]}, function cleanedUp(cleanUpErr) {
            // We shouldn't ever get a `cleanUpErr`. Let's be loud if we do.
            if (cleanUpErr) {
                log.fatal({err: cleanUpErr}, 'unexpected error cleaning up');
            }
            if (runErr || cleanUpErr) {
                cb(runErr || cleanUpErr);
                return;
            }

            if (context.execStart) {
                ui.info('Completed successfully (%selapsed %ds).',
                    (opts.dryRun ? 'dry-run, ' : ''),
                    Math.floor((Date.now() - context.execStart) / 1000));
            }
            cb();
        });
    });
}

// --- exports

module.exports = {
    coordinatePlan: coordinatePlan,
    runProcs: runProcs
};
// vim: set softtabstop=4 shiftwidth=4:
