/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup prometheus' CLI subcommand.
 */

var assert = require('assert-plus');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');


function do_prometheus(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    var start = Date.now();
    var svcName = 'prometheus';
    var svcData = {
        name: svcName,
        params: {
            package_name: 'sdc_1024',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'prometheus',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: svcName,
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var context = {
        sdcadm: self.sdcadm,
        didSomething: false,
        imageArg: opts.image || 'latest',
        channelRef: opts.channel || 'default'
    };

    vasync.pipeline({arg: context, funcs: [
        steps.sapi.assertFullMode,

        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },

        function ctxSvcDomain(ctx, next) {
            assert.string(self.sdcadm.sdcApp.metadata.datacenter_name,
                '"sdc" application\'s metadata must' +
                'have a "datacenter_name" property');
            assert.string(self.sdcadm.sdcApp.metadata.dns_domain,
                '"sdc" application\'s metadata must' +
                'have a "dns_domain" property');
            ctx.svcDomain = svcName + '.' +
                self.sdcadm.sdcApp.metadata.datacenter_name + '.' +
                self.sdcadm.sdcApp.metadata.dns_domain;
            next();
        },

        function ctxSvcPkg(ctx, next) {
            var filter = {name: svcData.params.package_name, active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    next(err);
                    return;
                } else if (pkgs.length !== 1) {
                    next(new errors.InternalError({
                        message: format('%d "%s" active package found',
                            pkgs.length, svcData.params.package_name)
                    }));
                    return;
                }
                ctx.svcPkg = pkgs[0];
                next();
            });
        },

        // Find the appropriate image to use. We use the `--image` option arg
        // to choose the appropriate image (limiting to the image name
        // for this service).
        //
        // This either errors out or sets `ctx.svcImg` to the image manifest
        // and `ctx.needToDownloadImg = true` if the image needs to be
        // downloaded from the image server.
        //
        // Dev Note: This should be a shared thing, perhaps as a step.
        function ctxSvcImg(ctx, next) {
            var imgName = self.sdcadm.config.imgNameFromSvcName[svcName];

            if (ctx.imageArg === 'latest') {
                self.sdcadm.updates.listImages({
                    name: imgName,
                    channel: opts.channel
                }, function (listErr, imgs) {
                    if (listErr) {
                        next(listErr);
                    } else if (imgs && imgs.length) {
                        // TODO presuming sorted by published_at
                        ctx.svcImg = imgs[imgs.length - 1];

                        self.sdcadm.imgapi.getImage(
                            ctx.svcImg.uuid,
                            function (getErr, img) {
                                if (getErr && getErr.body &&
                                    getErr.body.code === 'ResourceNotFound') {
                                    ctx.needToDownloadImg = true;
                                    next();
                                } else if (getErr) {
                                    next(getErr);
                                } else {
                                    assert.object(img, 'img');
                                    ctx.needToDownloadImg = false;
                                    next();
                                }
                            }
                        );
                    } else {
                        next(new errors.UpdateError(
                            format('no "%s" image found in %s channel of ' +
                                'updates server', imgName, ctx.channelRef)));
                    }
                });

            } else if (ctx.imageArg === 'current') {
                self.sdcadm.imgapi.listImages({
                    name: imgName
                }, function (err, imgs) {
                    if (err) {
                        next(err);
                    } else if (imgs && imgs.length) {
                        // TODO presuming sorted by published_at
                        ctx.svcImg = imgs[imgs.length - 1];
                        ctx.needToDownloadImg = false;
                        next();
                    } else {
                        next(new errors.UpdateError(format(
                            'no "%s" image found in this DC\'s IMGAPI',
                            imgName)));
                    }
                });

            } else if (common.UUID_RE.test(ctx.imageArg)) {
                // imageArg is the UUID of an image in the local IMGAPI or
                // in updates.joyent.com.
                self.sdcadm.getImage({
                    uuid: ctx.imageArg,
                    channel: opts.channel
                }, function (err, img) {
                    if (err && err.body &&
                        err.body.code === 'ResourceNotFound') {
                        next(new errors.UpdateError(format(
                            'no image "%s" was found in the %s channel of ' +
                            'the updates server',
                            ctx.imageArg, ctx.channelRef)));
                    } else if (err) {
                        next(err);
                    } else {
                        assert.object(img, 'img');
                        if (img.name !== imgName) {
                            next(new errors.UpdateError(format(
                                'image "%s" (%s) is not a "%s" image',
                                ctx.imageArg, img.name, imgName)));
                        } else {
                            ctx.svcImg = img;
                            // `SdcAdm.getImage` doesn't explicitly tell us if
                            // the image is already in the DC, but we can
                            // infer that from `img.channels`. If it has that
                            // field, then it was a response from querying
                            // updates.joyent.com.
                            ctx.needToDownloadImg =
                                img.hasOwnProperty('channels');
                            next();
                        }
                    }
                });

            } else {
                // imageArg must be an image `version`.
                self.sdcadm.imgapi.listImages({
                    name: imgName,
                    version: ctx.imageArg
                }, function (localErr, localImgs) {
                    if (localErr && !(localErr.body &&
                        localErr.body.code === 'ResourceNotFound')) {
                        next(localErr);
                    } else if (!localErr && localImgs && localImgs.length > 0) {
                        // TODO presuming sorted by published_at
                        ctx.svcImg = localImgs[localImgs.length - 1];
                        ctx.needToDownloadImg = false;
                        next();
                    } else {
                        // Look in updates.joyent.com.
                        self.sdcadm.updates.listImages({
                            name: imgName,
                            version: ctx.imageArg,
                            channel: opts.channel
                        }, function (updatesErr, updatesImgs) {
                            if (updatesErr) {
                                next(updatesErr);
                            } else if (updatesImgs && updatesImgs.length > 0) {
                                // TODO presuming sorted by published_at
                                ctx.svcImg = updatesImgs[
                                    updatesImgs.length - 1];
                                ctx.needToDownloadImg = true;
                                next();
                            } else {
                                next(new errors.UpdateError(format(
                                    'no "%s" image with version "%s" found ' +
                                    'in the %s channel of the updates server',
                                    imgName, ctx.imageArg, ctx.channelRef)));
                            }
                        });
                    }
                });
            }
        },

        function importSvcImageIfNecessary(ctx, next) {
            self.progress('Using image %s (%s@%s)', ctx.svcImg.uuid,
                ctx.svcImg.name, ctx.svcImg.version);
            if (!ctx.needToDownloadImg) {
                next();
                return;
            }

            self.progress('Need to import image %s from updates server',
                ctx.svcImg.uuid);
            var proc = new DownloadImages({
                images: [ctx.svcImg],
                channel: opts.channel
            });
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        function getSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: svcName,
                application_uuid: self.sdcadm.sdcApp.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (svcs && svcs.length > 0) {
                    ctx.svc = svcs[0];
                }
                next();
            });
        },

        function updateExistingSvc(ctx, next) {
            if (ctx.svc && ctx.svc.params.image_uuid !== ctx.svcImg.uuid) {
                ctx.svc.params.image_uuid = ctx.svcImg.uuid;
                self.progress('Updating "%s" SAPI service image_uuid',
                    svcName);
                ctx.didSomething = true;
                self.sdcadm.sapi.updateService(ctx.svc.uuid, ctx.svc, next);
            } else {
                next();
            }
        },

        shared.getUserScript,

        function createSvcIfNecessary(ctx, next) {
            if (ctx.svc) {
                next();
                return;
            }

            self.progress('Creating "%s" SAPI service', svcName);
            ctx.didSomething = true;

            svcData.params.image_uuid = ctx.svcImg.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata['SERVICE_DOMAIN'] = ctx.svcDomain;
            svcData.params.billing_id = ctx.svcPkg.uuid;
            delete svcData.params.package_name;

            self.sdcadm.sapi.createService(
                svcName,
                self.sdcadm.sdcApp.uuid,
                svcData,
                function (err, svc) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    ctx.svc = svc;
                    self.log.info({svc: svc}, 'created svc');
                    next();
                }
            );
        },

        function ctxHeadnodeUuid(ctx, next) {
            self.sdcadm.getCurrServerUuid(function (err, hnUuid) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.headnodeUuid = hnUuid;
                next();
            });
        },

        function ctxSvcSapiInsts(ctx, next) {
            assert.object(ctx.svc, 'ctx.svc');

            var filter = {
                service_uuid: ctx.svc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else {
                    ctx.svcSapiInsts = insts;
                    next();
                }
            });
        },

        function createFirstInstIfNecessary(ctx, next) {
            if (ctx.svcSapiInsts && ctx.svcSapiInsts.length > 0) {
                if (ctx.svcSapiInsts.length === 1) {
                    self.progress('Not creating an instance: there is ' +
                        'already one %s instance (VM %s)',
                        svcName, ctx.svcSapiInsts[0].params.alias);
                } else {
                    self.progress('Not creating an instance: there are ' +
                        'already %d %s instances',
                        ctx.svcSapiInsts.length, svcName);
                }
                next();
                return;
            }

            self.progress('Creating first "%s" instance on this server',
                svcName);
            ctx.didSomething = true;

            self.sdcadm.sapi.createInstance(
                ctx.svc.uuid,
                {
                    params: {
                        alias: svcName + '0',
                        server_uuid: ctx.headnodeUuid
                    }
                },
                function (err, inst) {

                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.firstInst = inst;
                next();
            });
        },

        function done(ctx, next) {
            if (ctx.didSomething) {
                self.progress('Setup "%s" (%ds)',
                    svcName,
                    Math.floor((Date.now() - start) / 1000));
            } else {
                self.progress('Service "%s" is already set up', svcName);
            }

            next();
        }
    ]}, cb);
}

do_prometheus.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'Specifies which image to use for the first instance. ' +
            'Use "latest" (the default) for the latest available on ' +
            'updates.joyent.com, "current" for the latest image already ' +
            'in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.joyent.com channel from which to fetch the ' +
            'image. See `sdcadm channel get` for the default channel.'
    }
];

do_prometheus.help = (
    'Create the "prometheus" service and a first instance.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} prometheus [OPTIONS]\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_prometheus: do_prometheus
};
