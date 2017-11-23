/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup cloudapi'
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var svcadm = require('../svcadm');

// --- internal support stuff


function createCloudapiInstance(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.func(callback, 'callback');

    var progress = opts.progress;
    var sdcadm = opts.sdcadm;
    var sapi = opts.sdcadm.sapi;

    var networks;
    var cloudapisvc;
    var changes = [];
    var img, history;

    // find cloudapi service, get service uuid
    // use sapi.createInstance to create the service

    vasync.pipeline({ arg: {}, funcs: [
        function (_, next) {
            sapi.listServices({ name: 'cloudapi' }, function (err, svcs) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                if (svcs.length !== 1) {
                    next(new Error('expected 1 cloudapi service, found %d',
                        svcs.length));
                    return;
                }
                cloudapisvc = svcs[0];
                next();
            });
        },
        function (_, next) {
            getNetworksAdminExternal(function (err, nets) {
                if (err) {
                    next(err);
                    return;
                }
                networks = nets;
                next();
            });
        },
        function (_, next) {
            sdcadm.updates.listImages({
                name: 'cloudapi'
            }, function (err, images) {
                if (err) {
                    next(new errors.SDCClientError(err, 'updates'));
                } else if (images && images.length) {
                    img = images[images.length - 1]; // XXX presuming sorted
                    next();
                } else {
                    next(new errors.UpdateError('no "cloudapi" image found'));
                }
            });
        },
        function (_, next) {
            changes.push({
                image: img,
                service: cloudapisvc,
                type: 'add-instance',
                inst: {
                    type: 'vm',
                    alias: opts.alias,
                    version: img.version,
                    service: 'cloudapi',
                    image: img.uuid
                }
            });
            sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    next(err);
                    return;
                }
                history = hst;
                next();
            });
        },
        function getHeadnode(ctx, next) {
            sdcadm.getCurrServerUuid(function (err, hn) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.headnodeUuid = hn;
                next();
            });
        },
        function (ctx, next) {
            var cOpts = {
                params: {
                    server_uuid: ctx.headnodeUuid,
                    alias: opts.alias,
                    networks: [
                        {
                            uuid: networks.admin.uuid
                        },
                        {
                            primary: true,
                            uuid: networks.external.uuid
                        }
                    ]
                }
            };
            sapi.createInstance(cloudapisvc.uuid, cOpts, function (err, inst) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                changes[0].inst.zonename = changes[0].inst.uuid = inst.uuid;
                next();
            });
        },
        function hupHermes(_, next) {
            svcadm.restartHermes({
                sdcadm: sdcadm,
                log: sdcadm.log,
                progress: progress
            }, next);
        }
    ] }, function (err) {
        if (!history) {
            sdcadm.log.warn('History not set for post-setup cloudapi');
            callback(err);
            return;
        }
        history.changes = changes;
        if (err) {
            history.error = err;
        }
        // No need to add `history.finished` here, History instance will do
        sdcadm.history.updateHistory(history, function (err2) {
            if (err) {
                callback(err);
            } else if (err2) {
                callback(err2);
            } else {
                progress('cloudapi0 zone created');
                callback();
            }
        });
    });

    function getNetworksAdminExternal(cb) {
        var napi = sdcadm.napi;
        var foundnets = {};

        napi.listNetworks({
            name: ['admin', 'external']
        }, function listNetworksCb(listerr, nets) {
            if (listerr) {
                cb(new errors.SDCClientError(listerr, 'sapi'));
                return;
            }

            if (!nets.length) {
                cb(new Error('Couldn\'t find admin network in NAPI'));
                return;
            }
            for (var i in nets) {
                foundnets[nets[i].name] = nets[i];
            }

            cb(null, foundnets);
        });
    }
}

function Cloudapi() {}

Cloudapi.prototype.name = 'cloudapi';
Cloudapi.prototype.help = (
    'Create a first cloudapi instance.\n' +
    '\n' +
    'Initial setup of SmartDataCenter does not create a cloudapi instance.\n' +
    'This procedure will do that for you.\n'
);
Cloudapi.prototype.execute = function cExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');
    assert.func(cb, 'cb');

    var log = options.log;
    var sdcadm = options.sdcadm;
    var progress = options.progress;

    function onInstances(err, insts) {
        if (err) {
            cb(err);
            return;
        }

        log.info({insts: insts}, '%d existing cloudapi insts', insts.length);
        if (insts.length === 1) {
            progress('Already have a cloudapi: vm %s (%s)',
                insts[0].instance, insts[0].alias);
            cb();
            return;
        } else if (insts.length > 1) {
            progress('Already have %d cloudapi instances: vm %s (%s), ...',
                insts.length, insts[0].instance, insts[0].alias);
            cb();
            return;
        }

        createCloudapiInstance({
            alias: 'cloudapi0',
            progress: progress,
            sdcadm: sdcadm
        }, cb);
    }

    sdcadm.listInsts({svcs: ['cloudapi']}, onInstances);
};



// --- CLI

function do_cloudapi(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    var proc = new Cloudapi();

    function setupCloudapi(options, callback) {
        proc.execute(options, callback);
    }

    function setupCloudapiCb(err) {
        if (err) {
            self.top.progress('CloudAPI setup failed');
            cb(err);
            return;
        }
        cb();
    }

    common.execWithRetries({
        func: setupCloudapi,
        cb: setupCloudapiCb,
        args: {
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'cloudapi'}, true),
            progress: self.top.progress
        },
        log: self.log,
        retries: opts.retries
    });


}

do_cloudapi.help = (
    Cloudapi.prototype.help +
    '\n' +
    'Usage:\n' +
    '     {{name}} cloudapi\n'
);

do_cloudapi.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];



// --- exports

module.exports = {
    do_cloudapi: do_cloudapi
};
