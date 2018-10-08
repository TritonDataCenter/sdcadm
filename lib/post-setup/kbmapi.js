/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup kbmapi' CLI subcommand.
 */

var common = require('../common');
var errors = require('../errors');
var format = require('util').format;
var shared = require('../procedures/shared');
var steps = require('../steps');
var vasync = require('vasync');
var DownloadImages = require('../procedures/download-images').DownloadImages;

function do_kbmapi(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    var start = Date.now();
    var svcData = {
        name: 'kbmapi',
        params: {
            package_name: 'sdc_1024',
            billing_id: 'TO_FILL_IN',
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: false,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'kbmapi',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'kbmapi',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var context = {
        sdcadm: self.sdcadm,
        imgsToDownload: [],
        didSomething: false
    };

    vasync.pipeline({arg: context, funcs: [
        steps.sapi.assertFullMode,
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        // XXX: We're not using CNS just yet, though I suspect we will, so
        // add the dep now
        function ensureCnsSvc(_, next) {
            self.sdcadm.sapi.listServices({
                name: 'cns',
                application_uuid: self.sdcadm.sdcApp.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (!svcs.length) {
                    next(new errors.UpdateError(
                        'The CNS service is required by KBMAPI.\n' +
                        common.indent('Please install it with ' +
                            '`sdcadm post-setup cns`.')));
                    return;
                }
                next();
            });
        },
        function getPkg(ctx, next) {
            var filter = {
                name: svcData.params.package_name,
                active: true
            };

            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    next(err);
                    return;
                }
                if (pkgs.length !== 1) {
                    next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            svcData.params.package_name)
                    }));
                    return;
                }
                ctx.kbmapiPkg = pkgs[0];
                next();
            });
        },
        function getSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'kbmapi',
                application_uuid: self.sdcadm.sdcApp.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                }
                if (svcs.length) {
                    ctx.kbmapiSvc = svcs[0];
                }
                next();
            });
        },
        function getInst(ctx, next) {
            if (!ctx.kbmapiSvc) {
                next();
                return;
            }

            var filter = {
                service_uuid: ctx.kbmapiSvc.uuid
            };

            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                if (insts && insts.length) {
                    ctx.kbmapiInst = insts[0];
                    next();
                    return;
                }
                next();
            });
        },
        function getLatestImage(ctx, next) {
            if (ctx.kbmapiInst) {
                next();
                return;
            }
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }

            var filter = {name: 'kbmapi'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                    return;
                }
                if (images && images.length) {
                    // NOTE: presumes results are sorted
                    ctx.kbmapiImg = images[images.length - 1];
                    next();
                    return;
                }
                next(new errors.UpdateError('no "kbmapi" image found'));
            });
        },
        function haveImageAlready(ctx, next) {
            if (ctx.kbmapiInst) {
                next();
                return;
            }
            self.sdcadm.imgapi.getImage(ctx.kbmapiImg.uuid,
                function (err, _img) {
                    if (err && err.body &&
                        err.body.code === 'ResourceNotFound') {
                        ctx.imgsToDownload.push(ctx.kbmapiImg);
                        next();
                        return;
                    }
                    if (err) {
                        next(err);
                        return;
                    }
                    next();
                });
        },
        function importImages(ctx, next) {
            if (ctx.imgsToDownload.length === 0) {
                next();
                return;
            }

            var proc = new DownloadImages({images: ctx.imgsToDownload});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },
        shared.getUserScript,
        function createSvc(ctx, next) {
            if (ctx.kbmapiSvc) {
                next();
                return;
            }

            var domain = self.sdcadm.sdcApp.metadata.datacenter_name + '.' +
                self.sdcadm.sdcApp.metadata.dns_domain;
            var svcDomain = svcData.name + '.' + domain;

            self.progress('Creating "kbmapi" service');
            ctx.didSomething = true;
            svcData.params.image_uuid = ctx.kbmapiImg.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata.SERVICE_DOMAIN = svcDomain;
            svcData.params.billing_id = ctx.kbmapiPkg.uuid;
            delete svcData.params.package_name;

            self.sdcadm.sapi.createService('kbmapi', self.sdcadm.sdcApp.uuid,
                svcData, function sapiCreateSvcCb(err, svc) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'kbmapi'));
                        return;
                    }
                    ctx.kbmapiSvc = svc;
                    self.log.info({svc: svc}, 'create "kbmapi" svc');
                    next();
                });
        },
        function getHeadnode(ctx, next) {
            self.sdcadm.getCurrServerUuid(function getHnCb(err, hn) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.headnodeUuid = hn;
                next();
            });
        },
        function createInst(ctx, next) {
            if (ctx.kbmapiInst) {
                next();
                return;
            }
            self.progress('Creating "kbmapi" instance');
            ctx.didSomething = true;

            var instOpts = {
                params: {
                    alias: 'kbmapi0',
                    server_uuid: ctx.headnodeUuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.kbmapiSvc.uuid, instOpts,
                function createInstCb(err, inst) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }
                    self.progress('Created VM %s (%s)', inst.uuid,
                        inst.params.alias);
                    next();
                });
        },
        function done(ctx, next) {
            if (ctx.didSomething) {
                self.progress('Setup "KBMAPI" (%ds)',
                    Math.floor((Date.now() - start) / 1000));
            }
            next();
        }
    ]}, cb);
}

do_kbmapi.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Update channel from which to get the "kbmapi" image,',
        helpArg: 'CHANNEL'
    }
];

do_kbmapi.help = (
    'Setup the Key Backup and Management API (KBMAPI) service.\n' +
    '\n' +
    'This will install and setup the "kbmapi" service.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} kbmapi\n' +
    '\n' +
    '{{options}}'
);

module.exports = {
    do_kbmapi: do_kbmapi
};
