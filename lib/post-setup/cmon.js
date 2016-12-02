/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * `sdcadm post-setup cmon` to create the 'cmon' service and its first
 * instance (on the headnode).
 */

var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');


function do_cmon(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var start = Date.now();
    var svcData = {
        name: 'cmon',
        params: {
            package_name: 'sdc_1024',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'},
                {name: 'external', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'cmon',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'cmon',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };


    var context = {
        imgsToDownload: [],
        didSomething: false
    };
    vasync.pipeline({arg: context, funcs: [
        function ensureSapiMode(_, next) {
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

        /* @field ctx.cmonPkg */
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
                ctx.cmonPkg = pkgs[0];
                next();
            });
        },

        function getSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cmon',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.cmonSvc = svcs[0];
                }
                next();
            });
        },

        /*
         * @field ctx.cmonInst
         */
        function getInst(ctx, next) {
            if (!ctx.cmonSvc) {
                return next();
            }
            var filter = {
                service_uuid: ctx.cmonSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.cmonInst = insts[0];
                    next();
                } else {
                    next();
                }
            });
        },

        function getLatestImage(ctx, next) {
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }

            var filter = {name: 'cmon'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.cmonImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "cmon" image found'));
                }
            });
        },

        function haveImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.cmonImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.cmonImg);
                } else if (err) {
                    return next(err);
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

        /* @field ctx.userString */
        shared.getUserScript,

        function createSvc(ctx, next) {
            if (ctx.cmonSvc) {
                next();
                return;
            }

            var domain = self.sdcadm.sdc.metadata.datacenter_name + '.' +
                    self.sdcadm.sdc.metadata.dns_domain;
            var svcDomain = svcData.name + '.' + domain;

            self.progress('Creating "cmon" service');
            ctx.didSomething = true;
            svcData.params.image_uuid = ctx.cmonImg.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            svcData.params.billing_id = ctx.cmonPkg.uuid;
            delete svcData.params.package_name;

            self.sdcadm.sapi.createService('cmon', self.sdcadm.sdc.uuid,
                    svcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.cmonSvc = svc;
                self.log.info({svc: svc}, 'created "cmon" svc');
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
        function createInst(ctx, next) {
            if (ctx.cmonInst) {
                next();
                return;
            }
            self.progress('Creating "cmon" instance');
            ctx.didSomething = true;
            var instOpts = {
                params: {
                    alias: 'cmon0',
                    server_uuid: ctx.headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.cmonSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                next();
            });
        },

        function done(ctx, next) {
            if (ctx.didSomething) {
                self.progress('Setup "cmon" (%ds)',
                    Math.floor((Date.now() - start) / 1000));
            }
            next();
        }
    ]}, cb);
}

do_cmon.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Update channel in which to look for the cmon image.',
        helpArg: 'CHANNEL'
    }
];
do_cmon.help = (
    'Create the "cmon" service and a first instance on the headnode.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} cmon\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_cmon: do_cmon
};
