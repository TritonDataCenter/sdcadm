/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The collection of "procedure" functions that know how to perform part of
 * an update plan (i.e. for `sdcadm update`).
 */

var p = console.log;
var assert = require('assert-plus');
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var once = require('once');
var os = require('os');
var path = require('path');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var verror = require('verror');

var common = require('../common');
var errors = require('../errors'),
    InternalError = errors.InternalError;
var svcadm = require('../svcadm');
var vmadm = require('../vmadm');



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
                'cns',
                'manta',
                'napi', 'portolan',
                'papi',
                'rabbitmq', 'redis', 'sdc', 'volapi', 'vmapi', 'workflow'];
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
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'not 1 inst');
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
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateSingleHeadnodeImgapi skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateSingleHeadnodeImgapi skip change: ' +
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
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateUFDSServiceV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateUFDSServiceV1 skip change: ' +
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
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateSingleHNSapiV1 skip change: ' +
                            'not 1 inst');
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
         * (handled by post-setup ha-manatee) or zookeeper instances, (handled
         * by post-setup zookeeper).
         *
         * Note that the nature of the create command makes it reach this
         * point with a single change, even when we keep this function using
         * arrays for consistency with the design for upgrades.
         */
        function createServiceInstance(_, next) {
            // Any instance which should never be created using
            // this tool should be here:
            var avoid = ['zookeeper', 'manatee', 'rabbitmq', 'sdc'];
            // Anything which can be created w/o --skip-ha-check flag should
            // be on this list:
            var allow = ['moray', 'workflow', 'cloudapi', 'mahi', 'nat',
                'papi'];
            var handle = [];
            var remaining = [];
            var err;

            changes.forEach(function (change) {
                if (change.type !== 'create') {
                    remaining.push(change);
                    return;
                }
                var allowed = ((avoid.indexOf(change.service.name) === -1) &&
                    (allow.indexOf(change.service.name) !== -1 ||
                     change.force));
                if (allowed) {
                    log.debug({
                        numInsts: 0,
                        svc: change.service.name,
                        server: change.server
                    }, 'CreateServiceIntanceV1 create service ' +
                    'additional instance');
                    handle.push(change);
                } else {
                    if (avoid.indexOf(change.service.name) === -1) {
                        // Let the user know about --skip-ha-check
                        err = new errors.UsageError(
                            'Must provide \'--skip-ha-check\' option in ' +
                            'order to create another instance of ' +
                            change.service.name);
                    } else {
                        remaining.push(change);
                    }
                }
            });

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

        },

        /**
         * Update individual agent instances
         */
        function updateAgent(_, next) {
            var errs = [];
            // Names of the agents which can be updated using this method:
            var allowed = ['cn-agent', 'vm-agent', 'net-agent',
                'agents_core', 'firewaller', 'smartlogin', 'config-agent',
                'amon-agent', 'amon-relay', 'hagfish-watcher'
            ];
            // Attempts on updating the following agents using this method will
            // result into an error message:
            var disallowed = ['provisioner', 'heartbeater', 'zonetracker',
                // TODO: the following agent services need to be added to
                // SAPI in order to be able to update them using this method:
                'cabase', 'cainstsvc'
            ];

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
                if (change.type !== 'update-service' ||
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

                var svcInsts = instsFromSvcName[change.service.name] || [];
                // If we have a given set of servers, just filter instances
                // present on the given list:
                if (opts.servers && opts.servers.length) {
                    svcInsts = svcInsts.filter(function (ins) {
                        return (opts.servers.indexOf(ins.server) !== -1);
                    });
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
                log.debug({
                    changes: handle
                }, 'UpdateAgentV1 will handle %d change(s)', handle.length);

                procs.push(new UpdateAgentV1({
                    changes: handle
                }));

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

                var svcInsts = instsFromSvcName[change.service.name] || [];
                // If we have a given set of servers, just filter instances
                // present on the given list:
                if (opts.servers && opts.servers.length) {
                    svcInsts = svcInsts.filter(function (ins) {
                        return (opts.servers.indexOf(ins.server) !== -1);
                    });
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
