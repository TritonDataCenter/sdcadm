/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The 'sdcadm experimental cns' CLI subcommand.
 */

var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');


function do_cns(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var start = Date.now();
    var svcData = {
        name: 'cns',
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
                smartdc_role: 'cns',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'cns',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };


    var context = {
        imgsToDownload: []
    };
    vasync.pipeline({arg: context, funcs: [
        /* @field ctx.cnsPkg */
        function getPkg(ctx, next) {
            var filter = {name: svcData.params.package_name,
                active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            svcData.params.package_name)
                    }));
                }
                ctx.cnsPkg = pkgs[0];
                next();
            });
        },

        function ensureSapiMode(_, next) {
            // Bail if SAPI not in 'full' mode.
            self.sdcadm.sapi.getMode(function (err, mode) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else if (mode !== 'full') {
                    next(new errors.UpdateError(format(
                        'SAPI is not in "full" mode: mode=%s', mode)));
                } else {
                    next();
                }
            });
        },

        function getSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cns',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.cnsSvc = svcs[0];
                }
                next();
            });
        },

        /*
         * @field ctx.cnsInst
         * @field ctx.cnsVm
         */
        function getCnsInst(ctx, next) {
            if (!ctx.cnsSvc) {
                return next();
            }
            var filter = {
                service_uuid: ctx.cnsSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.cnsInst = insts[0];
                    self.sdcadm.vmapi.getVm({uuid: ctx.cnsInst.uuid},
                            function (vmErr, cnsVm) {
                        if (vmErr) {
                            return next(vmErr);
                        }
                        ctx.cnsVm = cnsVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },

        function getLatestCnsImage(ctx, next) {
            var filter = {name: 'cns'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.cnsImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "cns" image found'));
                }
            });
        },

        function haveCnsImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.cnsImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.cnsImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function importImages(ctx, next) {
            if (ctx.imgsToDownload.length === 0) {
                return next();
            }
            var proc = new DownloadImages({images: ctx.imgsToDownload});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userString */
        shared.getUserScript,

        function createCnsSvc(ctx, next) {
            if (ctx.cnsSvc) {
                return next();
            }

            var domain = self.sdcadm.sdc.metadata.datacenter_name + '.' +
                    self.sdcadm.sdc.metadata.dns_domain;
            var svcDomain = svcData.name + '.' + domain;

            self.progress('Creating "cns" service');
            svcData.params.image_uuid = ctx.cnsImg.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            svcData.params.billing_id = ctx.cnsPkg.uuid;
            delete svcData.params.package_name;

            self.sdcadm.sapi.createService('cns', self.sdcadm.sdc.uuid,
                    svcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.cnsSvc = svc;
                self.log.info({svc: svc}, 'created cns svc');
                next();
            });
        },

        /* @field ctx.headnode */
        function getHeadnode(ctx, next) {
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                ctx.headnode = servers[0];
                return next();
            });
        },
        function createCnsInst(ctx, next) {
            if (ctx.cnsInst) {
                return next();
            }
            self.progress('Creating "cns" instance');
            var instOpts = {
                params: {
                    alias: 'cns0',
                    server_uuid: ctx.headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.cnsSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.newCnsInst = inst;
                next();
            });
        },

        function done(_, next) {
            self.progress('Added "cns" service and instance (%ds)',
                Math.floor((Date.now() - start) / 1000));
            next();
        }
    ]}, cb);
}

do_cns.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_cns.help = (
    'Create the "cns" service and a first instance.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} cns\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_cns: do_cns
};
