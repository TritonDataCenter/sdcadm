/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * The collection of "procedure" functions that know how to perform part of
 * an update plan (i.e. for `sdcadm update`).
 */

var assert = require('assert-plus');
var os = require('os');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

// --- HA ready services
var HA_READY_SVCS = [
    'cloudapi',
    'cmon',
    'mahi',
    'moray',
    'nat',
    'papi',
    'portolan',
    'workflow'
];

//---- internal support stuff

function NoOp() {}
NoOp.prototype.summarize = function noOpSummarize() {
    return 'no-op';
};
NoOp.prototype.execute = function noOpExecute(options, cb) {
    cb();
};



// --- procedures from the modules where we've defined them:
var DownloadImages = require('./download-images').DownloadImages;
var UpdateStatelessServicesV1 =
    require('./update-stateless-services-v1').UpdateStatelessServicesV1;
var UpdateSingleHeadnodeImgapi =
    require('./update-single-headnode-imgapi').UpdateSingleHeadnodeImgapi;
var UpdateUFDSServiceV1 =
    require('./update-ufds-service-v1').UpdateUFDSServiceV1;
var UpdateMorayV2 = require('./update-moray-v2').UpdateMorayV2;
var UpdateSingleHNSapiV1 =
    require('./update-single-hn-sapi-v1').UpdateSingleHNSapiV1;
var UpdateManateeV2 = require('./update-manatee-v2').UpdateManateeV2;
var UpdateBinderV2 = require('./update-binder-v2').UpdateBinderV2;
var UpdateMahiV2 = require('./update-mahi-v2').UpdateMahiV2;
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
                    return next(err);
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
         * Update services that are (a) stateless, (b) have a single instance
         * **on the headnode**, (c) with no current special handling (like
         * migrations).
         *
         * Here (b) implies this is the early SDC world where we don't have
         * HA multiple instances of services.
         */
        function updateSimpleServices(_, next) {
            var simpleServices = ['adminui', 'amon', 'amonredis', 'assets',
                'ca', 'cloudapi', 'cnapi', 'dhcpd', 'docker', 'fwapi',
                'cmon',
                'cns',
                'manta',
                'napi', 'portolan',
                'papi',
                'rabbitmq', 'redis', 'sdc', 'vmapi', 'workflow'];
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    ~simpleServices.indexOf(change.service.name))
                {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    ~simpleServices.indexOf(change.service.name))
                {
                    if (svcInsts.length === 0) {
                        log.debug({
                                numInsts: 0,
                                svc: change.service.name
                            }, 'UpdateStatelessServicesV1 update service ' +
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
                            log.debug({
                                    numInsts: svcInsts.length,
                                    svc: change.service.name
                                }, 'UpdateStatelessServicesV1 skip change: ' +
                                'not 1 inst');
                        }
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateStatelessServicesV1 skip change: ' +
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
                    'UpdateStatelessServicesV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateStatelessServicesV1({
                    changes: handle
                }));
            }
            next();
        },

        function updateSingleHeadnodeImgapi(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    change.service.name === 'imgapi')
                {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'imgapi')
                {
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

        function updateSingleHeadnodeUFDS(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    change.service.name === 'ufds')
                {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'ufds')
                {
                    if (svcInsts.length !== 1) {
                        if (opts.justAvailable) {
                            change.insts = svcInsts;
                            handle.push(change);
                        } else {
                            log.debug({
                                    numInsts: svcInsts.length,
                                    svc: change.service.name
                                }, 'UpdateUFDSServiceV1 skip change: ' +
                                'not 1 inst');
                        }
                    } else if (svcInsts[0].hostname !== currHostname) {
                        if (opts.justAvailable) {
                            change.insts = svcInsts;
                            handle.push(change);
                        } else {
                            log.debug({
                                    svc: change.service.name,
                                    cn: svcInsts[0].server
                                }, 'UpdateUFDSServiceV1 skip change: ' +
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
                    'UpdateUFDSServiceV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateUFDSServiceV1({
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
                    change.service.name === 'moray')
                {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'moray')
                {
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
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-instance' &&
                    change.service.name === 'sapi')
                {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'sapi')
                {
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
         * Manatee service upgrade.
         * Note we assume there's at least one manatee on the server from where
         * we are performing the upgrade.
         */
        function updateManatees(_, next) {
            var handle = [];
            var remaining = [];

            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'manatee') {
                    return cb(new errors.UsageError(
                        'Individual update of manatee instances ' +
                        'is not allowed'));
                }

                if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'manatee')
                {
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
            next();
        },

        function updateBinder(_, next) {
            var handle = [];
            var remaining = [];
            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'binder') {
                    return cb(new errors.UsageError(
                        'Individual update of binder instances ' +
                        'is not allowed'));
                }

                if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'binder')
                {
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
                    'UpdateBinderV2 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateBinderV2({ changes: handle }));
            }
            next();
        },

        function updateMahi(_, next) {
            var handle = [];
            var remaining = [];
            changes.forEach(function (change) {
                if (change.type === 'update-instance' &&
                    change.service.name === 'mahi')
                {
                    change.inst = change.instance;
                    handle.push(change);
                } else if ((change.type === 'update-service' ||
                    change.type === 'rollback-service') &&
                    change.service.name === 'mahi')
                {
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
                    'UpdateMahiV2 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateMahiV2({ changes: handle }));
            }
            next();
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
            var avoid = ['binder', 'manatee', 'rabbitmq', 'sdc', 'zookeeper'];

            var handle = [];
            var remaining = [];
            var err;

            function processChange(change, nextChange) {
                if (change.type !== 'create') {
                    remaining.push(change);
                    return nextChange();
                }
                sdcadm.cnapi.getServer(change.server, function (sErr, serv) {
                    if (sErr) {
                        remaining.push(change);
                        err = new errors.UsageError('Cannot find server \'' +
                                change.server + '\'');
                        log.error({err: sErr}, 'createServiceInstance');
                        return nextChange();
                    }

                    var sName = change.service.name;
                    var allowed = ((avoid.indexOf(sName) === -1) &&
                        (HA_READY_SVCS.indexOf(sName) !== -1 || change.force));

                    if (allowed) {
                        log.debug({
                            numInsts: 0,
                            svc: sName,
                            server: change.server
                        }, 'CreateServiceIntanceV1 create service ' +
                        'additional instance');
                        handle.push(change);
                    } else {
                        if (avoid.indexOf(sName) === -1) {
                            // Let the user know about --skip-ha-check
                            err = new errors.UsageError(
                                'Must provide \'--skip-ha-check\' option in ' +
                                'order to create another instance of ' +
                                sName);
                        } else {
                            remaining.push(change);
                        }
                    }

                    return nextChange();

                });
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
                'amon-agent', 'amon-relay', 'hagfish-watcher', 'cabase',
                'cainstsvc', 'cmon-agent'
            ];
            // Attempts on updating the following agents using this method will
            // result into an error message:
            var disallowed = ['provisioner', 'heartbeater', 'zonetracker'];

            var handle = [];
            var remaining = [];

            // Make sure we get a list of uuids even if hostnames may be
            // initially present as servers option:
            if (opts.servers) {
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
                if (disallowed.indexOf(change.service.name) !== -1) {
                    errs.push(change.service.name);
                    remaining.push(change);
                    return;
                }

                var svcInsts;
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
                    svcInsts = [change.instance];
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
            var err = null;
            if (errs.length) {
                err = new errors.UsageError(format(
                    'Update of the agents \'%s\' is not supported.\n' +
                    'Please consider using `sdcadm experimental ' +
                    'update-agents` (deprecated) instead.',
                    errs.join(', ')));
            }
            next(err);
        },

        function dockerLogger(_, next) {
            var handle = [];
            var remaining = [];

            // Make sure we get a list of uuids even if hostnames may be
            // initially present as servers option:
            if (opts.servers) {
                opts.servers = opts.servers.map(function (s) {
                    return opts.serverFromUuidOrHostname[s].uuid;
                });
            }

            changes.forEach(function (change) {
                if (change.service.name !== 'dockerlogger') {
                    remaining.push(change);
                    return;
                }

                var svcInsts;
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
                    svcInsts = [change.instance];
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
            next();
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
            cb(new errors.UpdateError(
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


//---- exports

module.exports = {
    coordinatePlan: coordinatePlan
};
// vim: set softtabstop=4 shiftwidth=4:
