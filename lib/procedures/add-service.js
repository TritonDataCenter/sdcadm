/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

/*
 * Procedure to add a new service to Triton, including service creation in
 * SAPI and instance creation through SAPI, using the provided (or latest
 * available) image.
 *
 * Limitation: This is primarily about *adding* a new service. If the service
 * and an instance already exists, there are some limitations. Specifically,
 * if there are service "params" updates, then the service definition in SAPI
 * *will* be updated. However, only an update of params.image_uuid will be
 * applied to an already-existing VM instance.
 */
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var jsprim = require('jsprim');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var common = require('../common');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var errors = require('../errors');
var Procedure = require('./procedure').Procedure;
var shared = require('../procedures/shared');
var steps = require('../steps');


/*
 * Return `null` (falsey) if there are no "<svc>.params" diffs between the
 * two given service definitions. Otherwise return an array of field names
 * that have differences.
 */
function svcParamsDiffFields(currSvc, targSvc) {
    if (jsprim.deepEqual(currSvc.params, targSvc.params)) {
        return null;
    }

    var field;
    var diffFieldSet = {};
    for (field of Object.keys(currSvc.params)) {
        if (!jsprim.deepEqual(currSvc.params[field], targSvc.params[field])) {
            diffFieldSet[field] = true;
        }
    }
    for (field of Object.keys(targSvc.params)) {
        if (!jsprim.deepEqual(currSvc.params[field], targSvc.params[field])) {
            diffFieldSet[field] = true;
        }
    }
    var diffFields = Object.keys(diffFieldSet);
    assert.ok(diffFields.length > 0);

    return diffFields;
}

/*
 * A Procedure to add a new SAPI service (and instance) on the 'sdc' app.
 *
 * Options:
 * - `imgNames` - Optional. An array of image names to consider for this
 *   service. Typically this can be left off and the `imgNameFromSvcName`
 *   config will be used. It is useful for the rare service where to
 *   correct image name depends on other variables (e.g. the 'manta' service).
 * - TODO: doc other options
 */
function AddServiceProcedure(options) {
    assert.object(options, 'options');
    assert.string(options.svcName, 'options.svcName');
    assert.optionalArrayOfString(options.imgNames, 'options.imgNames');
    assert.optionalString(options.image, 'options.image');
    assert.optionalString(options.channel, 'options.channel');
    assert.optionalString(options.server, 'options.server');
    assert.optionalString(options.packageName, 'options.packageName');
    assert.optionalBool(options.delegatedDataset, 'options.delegatedDataset');
    assert.optionalArrayOfObject(options.networks, 'options.networks');
    assert.optionalBool(options.firewallEnabled, 'options.firewallEnabled');
    assert.optionalArrayOfString(options.dependencies, 'options.dependencies');

    this.svcData = {
        name: options.svcName,
        params: {
            package_name: options.packageName || 'sdc_1024',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: Boolean(options.delegatedDataset) || false,
            maintain_resolvers: true,
            networks: options.networks || [
                {name: 'admin'}
            ],
            firewall_enabled: Boolean(options.firewallEnabled) || false,
            tags: {
                smartdc_role: options.svcName,
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: options.svcName,
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };
    this.svcName = options.svcName;
    this.imgNames = options.imgNames;
    this.imgArg = options.image || 'latest';
    this.channelArg = options.channel;
    this.dependencies = options.dependencies || [];
    if (options.server) {
        this.server = options.server;
    }
}
util.inherits(AddServiceProcedure, Procedure);

/*
 * Go through existing service details in Triton, if any, and retrieve all the
 * information required in order to proceed to service addition to the current
 * Triton setup, if that's the case.
 *
 * Object properties set by this method are:
 * - @svcDomain (String)
 * - @svcPkg (Object)
 * - @svc (Object) In case the service already exists
 * - @svcInst (Object) In case at least one service instance exists
 * - @svcInsts (Object) In case one or more service instance exist
 * - @svcVm (Object) In case at least one service instance exists
 * - @svcImg (Object)
 * - @needToDownloadImg (Boolean)
 * - @serverUuid (String) UUID of the server to create the first svc instance
 */
AddServiceProcedure.prototype.prepare = function addServicePrepare(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');

    const self = this;
    const sdcadm = opts.sdcadm;
    const context = {
        sdcadm: sdcadm,
        imgArg: self.imgArg,
        channelArg: self.channelArg,
        svcName: self.svcName,
        imgNames: self.imgNames
    };

    vasync.pipeline({
        arg: context,
        funcs: [
            sdcadm.ensureSdcApp.bind(sdcadm),
            function checkDependencies(_, next) {
                if (self.dependencies.length === 0) {
                    next();
                    return;
                }
                let missingSvcs = [];
                vasync.forEachParallel({
                    inputs: self.dependencies,
                    func: function checkSvcPresent(svc, nextSvc) {
                        sdcadm.sapi.listServices({
                            name: svc,
                            application_uuid: sdcadm.sdcApp.uuid
                        }, function (svcErr, svcs) {
                            if (svcErr) {
                                nextSvc(svcErr);
                                return;
                            }
                            if (!svcs.length) {
                                missingSvcs.push(svc);
                            }
                            nextSvc();
                        });
                    }
                }, function paraCb(paraErr) {
                    if (paraErr) {
                        next(paraErr);
                        return;
                    }

                    if (missingSvcs.length) {
                        let message;
                        if (missingSvcs.length === 1) {
                            message = [
                                util.format('The "%s" service is required',
                                    missingSvcs[0]),
                                util.format('Please, install it with ' +
                                    '`sdcadm post-setup %s`.',
                                    missingSvcs[0])
                            ];
                        } else {
                            message = [
                                util.format('The "%s" services are required',
                                    missingSvcs.join('", "')),
                                'Please, install them with:'
                            ];
                            missingSvcs.forEach(function addMissingSvc(svc) {
                                message.push(util.format(
                                    '`sdcadm post-setup %s`', svc));
                            });
                        }
                        next(new errors.UpdateError(message.join('\n')));
                        return;
                    }
                    next();
                });
            },
            function getSvcDomain(_, next) {
                assert.string(sdcadm.sdcApp.metadata.datacenter_name,
                    '"sdc" application\'s metadata must' +
                    ' have a "datacenter_name" property');
                assert.string(sdcadm.sdcApp.metadata.dns_domain,
                    '"sdc" application\'s metadata must' +
                    ' have a "dns_domain" property');

                self.svcDomain = self.svcName + '.' +
                    sdcadm.sdcApp.metadata.datacenter_name + '.' +
                    sdcadm.sdcApp.metadata.dns_domain;
                self.svcData.metadata['SERVICE_DOMAIN'] = self.svcDomain;
                next();
            },
            function getSvcPkg(_, next) {
                assert.object(self.svcData.params, 'self.svcData.params');
                assert.string(self.svcData.params.package_name,
                    'self.svcData.params.package_name');

                sdcadm.papi.list({
                    name: self.svcData.params.package_name,
                    active: true
                }, {}, function listPkgsCb(err, pkgs) {
                    if (err) {
                        next(err);
                        return;
                    } else if (pkgs.length !== 1) {
                        next(new errors.InternalError({
                            message: format('%d "%s" packages found',
                                pkgs.length,
                                self.svcData.params.package_name)
                        }));
                        return;
                    }
                    self.svcPkg = pkgs[0];
                    self.svcData.params.billing_id = self.svcPkg.uuid;
                    delete self.svcData.params.package_name;
                    next();
                });
            },

            function getSvc(_, next) {
                sdcadm.sapi.listServices({
                    name: self.svcName,
                    application_uuid: sdcadm.sdcApp.uuid
                }, function listSvcsCb(svcErr, svcs) {
                    if (svcErr) {
                        next(svcErr);
                        return;
                    } else if (svcs.length) {
                        self.svc = svcs[0];
                    }
                    next();
                });
            },

            function getInstAndVm(_, next) {
                if (!self.svc) {
                    next();
                    return;
                }
                sdcadm.sapi.listInstances({
                    service_uuid: self.svc.uuid
                }, function listInstCb(err, insts) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    } else if (insts && insts.length) {
                        self.svcInsts = insts;
                        self.svcInst = insts[0];
                        sdcadm.vmapi.getVm({
                            uuid: self.svcInst.uuid
                        }, function getVmCb(vmErr, vm) {
                            if (vmErr) {
                                next(vmErr);
                                return;
                            }
                            self.svcVm = vm;
                            next();
                        });
                    } else {
                        next();
                    }
                });
            },

            // Find an image for this service.
            //
            // input args:
            // - sdcadm
            // - svcName
            // - imgNames
            // - channelArg (from `--channel`)
            // - imgArg (from `--image`)
            // output args:
            // - svcImg=(img manifest)
            // - needToDownloadImg=true|false
            // - channel (if needed to talk to updates.jo)
            steps.images.findSvcImg,
            function updateSvcDataImg(ctx, next) {
                self.svcData.params.image_uuid = ctx.svcImg.uuid;
                next();
            },

            function getServer(_, next) {
                if (!self.server) {
                    sdcadm.getCurrServerUuid(function getHnCb(err, hn) {
                        if (err) {
                            next(err);
                            return;
                        }
                        self.serverUuid = hn;
                        next();
                    });
                } else if (common.UUID_RE.test(self.server)) {
                    sdcadm.cnapi.getServer(self.server,
                        function getServerCb(err, srv) {
                        if (err) {
                            next(err);
                            return;
                        }
                        self.serverUuid = srv.uuid;
                        next();
                    });
                } else {
                    sdcadm.cnapi.listServers({
                        hostname: self.server
                    }, function listServersCb(err, srvs) {
                        if (err) {
                            next(err);
                            return;
                        }

                        if (!srvs.length) {
                            next(new errors.ValidationError('Cannot find a ' +
                                'server with the provided hostname \'%s\'',
                                self.server));
                            return;
                        }

                        self.serverUuid = srvs[0].uuid;
                        next();
                    });
                }
            },

            // output args:
            // - self.userScript
            function getUserScript(_, next) {
                shared.getUserScript(self, function (err) {
                    if (err) {
                        next(err);
                    } else {
                        self.svcData.metadata['user-script'] = self.userScript;
                        next();
                    }
                });
            }
        ]
    }, function prepareCb(prepareErr) {
        if (prepareErr) {
            cb(prepareErr);
            return;
        }

        // Save data from `findSvcImg()`.
        self.needToDownloadImg = context.needToDownloadImg;
        self.channel = context.channel;
        self.svcImg = context.svcImg;

        // Check if any service params differ from intended.
        self.svcParamsToUpdate = null;
        if (self.svc) {
            self.svcParamsToUpdate = svcParamsDiffFields(
                self.svc, self.svcData);
        }

        let nothingToDo = true;
        // Unless we hit one of these, there's no need to run the procedure's
        // execute method, and summarize should inform the user accordingly
        if (!self.svc ||
            self.needToDownloadImg ||
            self.svcParamsToUpdate ||
            !self.svcInst ||
            (self.svcInsts.length === 1 &&
             self.svcVm.image_uuid !== self.svcImg.uuid)) {
            nothingToDo = false;
        }
        cb(null, nothingToDo);
    });
};


AddServiceProcedure.prototype.summarize = function addServiceSummarize() {
    const self = this;
    // Make sure prepare run before summarize:
    assert.string(self.svcName, 'self.svcName');
    assert.object(self.svcImg, 'self.svcImg');

    let out = [];

    if (!self.svc) {
        out.push(sprintf('create "%s" service in SAPI', self.svcName));
    }

    if (self.needToDownloadImg) {
        out.push(sprintf('download image %s (%s@%s)\n' +
            '    from updates server using channel "%s"', self.svcImg.uuid,
            self.svcImg.name, self.svcImg.version, self.channel));
    }

    if (self.svcParamsToUpdate) {
        out.push(sprintf('update service "%s" params in SAPI: %s',
            self.svcName, self.svcParamsToUpdate.join(', ')));
    }

    if (!self.svcInst) {
        out.push(sprintf('create "%s" service instance on server %s\n' +
                '    with image %s (%s@%s)',
            self.svcName,
            self.serverUuid,
            self.svcImg.uuid,
            self.svcImg.name,
            self.svcImg.version));
    } else if (self.svcInsts.length === 1 &&
            self.svcVm.image_uuid !== self.svcImg.uuid) {
        out.push(sprintf('reprovision instance %s (%s)\n' +
                '    with image %s (%s@%s)',
            self.svcInst.uuid,
            self.svcInst.params.alias || '<alias not set>',
            self.svcImg.uuid,
            self.svcImg.name,
            self.svcImg.version));
    }

    return out.join('\n');
};

AddServiceProcedure.prototype.execute = function addServiceExecute(opts, cb) {
    const self = this;
    // Make sure prepare run before execute:
    assert.object(self.svcImg, 'self.svcImg');
    assert.object(self.svcData, 'self.svcData');
    assert.object(self.svcPkg, 'self.svcPkg');
    assert.string(self.serverUuid, 'self.serverUuid');

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');

    const sdcadm = opts.sdcadm;
    const log = opts.log;
    const ui = opts.ui;

    vasync.pipeline({
        funcs: [
            function importSvcImageIfNecessary(_, next) {
                if (!self.needToDownloadImg) {
                    next();
                    return;
                }

                ui.info('Importing image %s (%s@%s)', self.svcImg.uuid,
                    self.svcImg.name, self.svcImg.version);
                var proc = new DownloadImages({
                    images: [self.svcImg],
                    channel: self.channel
                });
                proc.execute({
                    sdcadm: sdcadm,
                    log: log,
                    ui: ui,
                    progress: ui.progressFunc()
                }, next);
            },

            function updateExistingSvc(_, next) {
                if (self.svc &&
                    self.svcParamsToUpdate) {
                    self.svc.params = self.svcData.params;
                    ui.info('Updating "%s" SAPI service params: %s',
                        self.svcName, self.svcParamsToUpdate.join(', '));
                    sdcadm.sapi.updateService(self.svc.uuid, self.svc, next);
                } else {
                    next();
                }
            },

            function createSvc(_, next) {
                if (self.svc) {
                    next();
                    return;
                }

                ui.info('Creating "' + self.svcName + '" service');

                sdcadm.sapi.createService(self.svcName, sdcadm.sdcApp.uuid,
                        self.svcData, function createSvcCb(err, svc) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    self.svc = svc;
                    log.info({svc: svc}, 'created ' + self.svcName + ' svc');
                    next();
                });
            },

            function createInst(_, next) {
                if (self.svcInst) {
                    next();
                    return;
                }
                ui.info('Creating "%s" instance on server %s',
                    self.svcName, self.serverUuid);
                var instOpts = {
                    params: {
                        alias: self.svcName + '0',
                        server_uuid: self.serverUuid
                    }
                };
                sdcadm.sapi.createInstance(
                    self.svc.uuid,
                    instOpts, function createInstCb(err, inst) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    ui.info('Created VM %s (%s)', inst.uuid,
                        inst.params.alias);
                    self.svcInst = inst;
                    self.createdSvcInst = true;
                    next();
                });
            },

            // We don't want to get into handling updates of multiple (possibly
            // many) instances, because `sdcadm up` is better equipped to do
            // that. However, for the common case where there is a single
            // instance of the service, it is useful to have the result of
            // a re-run of `sdcadm post-setup $service` be a running instance
            // using the specified image version.
            function reprovisionSingleInst(_, next) {
                if (self.createdSvcInst) {
                    // Just created the instance above.
                    next();
                    return;
                } else if (self.svcInst.image_uuid === self.svcImg.uuid) {
                    // The instance has the desired image (assuming likewise
                    // for other instances if there are any).
                    next();
                    return;
                } else if (self.svcInsts.length > 1) {
                    ui.info('Not reprovisioning multiple (%d) %s instances, ' +
                            'use "sdcadm up %s@%s"',
                        self.svcInsts.length,
                        self.svcName,
                        self.svcName,
                        self.svcImg.uuid);
                    next();
                    return;
                }

                ui.info('Reprovisioning instance "%s" (%s)',
                    self.svcInst.uuid, self.svcInst.params.alias);
                sdcadm.sapi.reprovisionInstance(
                    self.svcInst.uuid,
                    self.svcImg.uuid,
                    function reprovisionedCb(err) {
                        if (err) {
                            next(new errors.SDCClientError(err, 'sapi'));
                            return;
                        }
                        ui.info('Reprovisioned instance "%s" (%s)',
                            self.svcInst.uuid, self.svcInst.params.alias);
                        next();
                    }
                );
            }

        ]}, cb);
};


// --- exports

module.exports = {
    AddServiceProcedure: AddServiceProcedure
};

// vim: set softtabstop=4 shiftwidth=4:
