/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
'use strict';
/*
 * Procedure to add a new service to Triton, including service creation in
 * SAPI and instance creation through SAPI, using the provided (or latest
 * available) image.
 *
 * Expected usage is:
 *
 * var myService = new AddServiceProcedure({
 *      svcName = 'my-service'
 * });
 *
 * myService.prepare({
 *      sdcadm: sdcadm
 * }, function prepareCb(prepareErr) {
 *      if (prepareErr) {
 *          return;
 *      }
 *      myService.summarize();
 *      # promptYesNo(...);
 *      myService.execute({
 *          sdcadm: sdcadm,
 *          log: log,
 *          ui: ui
 *      }, executeCb(executeErr) {
 *          if (executeErr) {
 *              return;
 *          }
 *          done();
 *      })
 * });
 *
 * TODO: Some services also require the parallel setup of a related agent.
 * Consider including that into the current procedure (Or maybe go for a
 * separate procedure for new agents setup?)
 */
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var common = require('../common');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var errors = require('../errors');
var Procedure = require('./procedure').Procedure;
var shared = require('../procedures/shared');

function AddServiceProcedure(options) {
    assert.object(options, 'options');
    assert.string(options.svcName, 'options.svcName');
    assert.optionalObject(options.svcData, 'options.svcData');
    assert.optionalString(options.image, 'options.image');
    assert.optionalString(options.channel, 'options.channel');
    assert.optionalString(options.server, 'options.server');

    // Sometimes running the procedure will result in doing nothing at all:
    this.needsToRun = false;

    this.svcData = options.svcData || {
        name: options.svcName,
        params: {
            package_name: 'sdc_1024',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: false,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'}
            ],
            firewall_enabled: false,
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
    this.imageArg = options.image || 'latest';
    this.channelRef = options.channel || 'default';
}
util.inherits(AddServiceProcedure, Procedure);

AddServiceProcedure.prototype.summarize = function addServiceSummarize() {
    const self = this;
    // Make sure prepare run before summarize:
    assert.string(self.svcName, 'self.svcName');
    assert.object(self.svcImg, 'self.svcImg');

    // Provide informative message in case the caller want to let the user
    // know there's nothing to do for a given service
    if (!self.needsToRun) {
        return sprintf('service "%s" already exists in SAPI, is using ' +
            'the desired image and\nat least one instance has been created ' +
            'before.', self.svcName);
    }

    let out = [];

    if (!self.svc) {
        out.push(sprintf('create "%s" service in SAPI', self.svcName));
    }

    if (self.needToDownloadImg) {
        out.push(sprintf('download image %s (%s@%s)\n' +
            '    from updates server using channel "%s"', self.svcImg.uuid,
            self.svcImg.name, self.svcImg.version, self.channelRef));
    }

    if (self.svc && self.svc.params.image_uuid !== self.svcImg.uuid) {
        out.push(sprintf('update service "%s" in SAPI\n' +
            '    to image %s (%s@%s)', self.svcName, self.svcImg.uuid,
            self.svcImg.name, self.svcImg.version));
    }

    if (!self.svcInst) {
        out.push(sprintf('create "%s" service instance in server "%s"',
            self.svcName, self.serverUuid));
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

                ui.info('Using image %s (%s@%s)', self.svcImg.uuid,
                    self.svcImg.name, self.svcImg.version);

                ui.info('Need to import image %s from updates server',
                    self.svcImg.uuid);
                var proc = new DownloadImages({
                    images: [self.svcImg],
                    channel: self.channelRef
                });
                proc.execute({
                    sdcadm: sdcadm,
                    log: log,
                    ui: ui
                }, next);
            },

            function getUserScript(_, next) {
                shared.getUserScript(self, next);
            },

            function updateExistingSvc(_, next) {
                if (self.svc &&
                    self.svc.params.image_uuid !== self.svcImg.uuid) {
                    self.svc.params.image_uuid = self.svcImg.uuid;
                    ui.info('Updating "%s" SAPI service image_uuid',
                        self.svcName);
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
                self.svcData.params.image_uuid = self.svcImg.uuid;
                self.svcData.metadata['user-script'] = self.userScript;
                self.svcData.metadata['SERVICE_DOMAIN'] = self.svcDomain;
                self.svcData.params.billing_id = self.svcPkg.uuid;
                delete self.svcData.params.package_name;

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
                    if (self.svcInsts.length === 1) {
                        ui.info('Not creating an instance: there is ' +
                            'already one %s instance (VM %s)',
                            self.svcName, self.svcInst.params.alias);
                    } else {
                        ui.info('Not creating an instance: there are ' +
                            'already %d %s instances',
                            self.svcInsts.length, self.svcName);
                    }
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
                    next();
                });
            }

        ]}, cb);
};



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

    vasync.pipeline({
        arg: {},
        funcs: [
            sdcadm.ensureSdcApp.bind(sdcadm),
            function getChannel(_, next) {
                if (self.channelRef === 'default') {
                    sdcadm.getDefaultChannel(function (err, channel) {
                        if (err) {
                            next(err);
                            return;
                        }
                        self.channelRef = channel;
                        next();
                        return;
                    });
                }
                next();
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

            // Find the appropriate image to use. We use the `--image` option
            // arg to choose the appropriate image (limiting to the image name
            // for this service).
            //
            // This either errors out or sets `this.svcImg` to the image
            // manifest and `this.needToDownloadImg = true` if the image needs
            // to be downloaded from the image server.
            function getSvcImg(_, next) {
                const imgName = sdcadm.config.imgNameFromSvcName[self.svcName];
                // Just in case it's undefined and we finish up retrieving a
                // really huge list from updates.jo
                assert.string(imgName, 'imgName');

                if (self.imageArg === 'latest') {
                    sdcadm.updates.listImages({
                        name: imgName,
                        channel: self.channelRef
                    }, function (listErr, imgs) {
                        if (listErr) {
                            next(listErr);
                        } else if (imgs && imgs.length) {
                            // TODO presuming sorted by published_at
                            self.svcImg = imgs[imgs.length - 1];

                            sdcadm.imgapi.getImage(
                                self.svcImg.uuid,
                                function (getErr, img) {
                                    if (getErr && getErr.body &&
                                        getErr.body.code ===
                                        'ResourceNotFound') {
                                        self.needToDownloadImg = true;
                                        next();
                                    } else if (getErr) {
                                        next(getErr);
                                    } else {
                                        assert.object(img, 'img');
                                        self.needToDownloadImg = false;
                                        next();
                                    }
                                }
                            );
                        } else {
                            next(new errors.UpdateError(
                                format('no "%s" image found in %s channel of ' +
                                    'updates server',
                                    imgName, self.channelRef)));
                        }
                    });

                } else if (self.imageArg === 'current') {
                    sdcadm.imgapi.listImages({
                        name: imgName
                    }, function (err, imgs) {
                        if (err) {
                            next(err);
                        } else if (imgs && imgs.length) {
                            // TODO presuming sorted by published_at
                            self.svcImg = imgs[imgs.length - 1];
                            self.needToDownloadImg = false;
                            next();
                        } else {
                            next(new errors.UpdateError(format(
                                'no "%s" image found in this DC\'s IMGAPI',
                                imgName)));
                        }
                    });

                } else if (common.UUID_RE.test(self.imageArg)) {
                    // imageArg is the UUID of an image in the local IMGAPI or
                    // in updates.joyent.com.
                    sdcadm.getImage({
                        uuid: self.imageArg,
                        channel: self.channelRef
                    }, function (err, img) {
                        if (err && err.body &&
                            err.body.code === 'ResourceNotFound') {
                            next(new errors.UpdateError(format(
                                'no image "%s" was found in the %s channel of' +
                                ' the updates server',
                                self.imageArg, self.channelRef)));
                        } else if (err) {
                            next(err);
                        } else {
                            assert.object(img, 'img');
                            if (img.name !== imgName) {
                                next(new errors.UpdateError(format(
                                    'image "%s" (%s) is not a "%s" image',
                                    self.imageArg, img.name, imgName)));
                            } else {
                                self.svcImg = img;
                                // `SdcAdm.getImage` doesn't explicitly tell us
                                // if the image is already in the DC, but we
                                // can infer that from `img.channels`. If it
                                // has that field, then it was a response from
                                // querying updates.joyent.com.
                                self.needToDownloadImg =
                                    img.hasOwnProperty('channels');
                                next();
                            }
                        }
                    });

                } else {
                    // imageArg must be an image `version`.
                    sdcadm.imgapi.listImages({
                        name: imgName,
                        version: self.imageArg
                    }, function (localErr, localImgs) {
                        if (localErr && !(localErr.body &&
                            localErr.body.code === 'ResourceNotFound')) {
                            next(localErr);
                        } else if (!localErr && localImgs &&
                            localImgs.length > 0) {
                            // TODO presuming sorted by published_at
                            self.svcImg = localImgs[localImgs.length - 1];
                            self.needToDownloadImg = false;
                            next();
                        } else {
                            // Look in updates.joyent.com.
                            sdcadm.updates.listImages({
                                name: imgName,
                                version: self.imageArg,
                                channel: self.channelRef
                            }, function (updatesErr, updatesImgs) {
                                if (updatesErr) {
                                    next(updatesErr);
                                } else if (updatesImgs &&
                                    updatesImgs.length > 0) {
                                    // TODO presuming sorted by published_at
                                    self.svcImg = updatesImgs[
                                        updatesImgs.length - 1];
                                    self.needToDownloadImg = true;
                                    next();
                                } else {
                                    next(new errors.UpdateError(format(
                                        'no "%s" image with version "%s" ' +
                                        'found in the %s channel of the ' +
                                        'updates server',
                                        imgName, self.imageArg,
                                        self.channelRef)));
                                }
                            });
                        }
                    });
                }
            },

            function getVmServer(_, next) {
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
                                'server with the provided hostname'));
                            return;
                        }

                        self.serverUuid = srvs[0].uuid;
                        next();
                    });
                }
            }
        ]
    }, function prepareCb(prepareErr) {
        if (prepareErr) {
            cb(prepareErr);
            return;
        }
        // Unless we hit one of these, there's no need to run the procedure's
        // execute method, and summarize should inform the user accordingly
        if (!self.svc ||
            self.needToDownloadImg ||
            self.svc.params.image_uuid !== self.svcImg.uuid ||
            !self.svcInst) {
            self.needsToRun = true;
        }
        cb(null, !self.needsToRun);
    });
};

// --- exports

module.exports = {
    AddServiceProcedure: AddServiceProcedure
};

// vim: set softtabstop=4 shiftwidth=4:
