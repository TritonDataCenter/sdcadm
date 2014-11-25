/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;

var vasync = require('vasync');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');
var errors = require('../errors');

function CreateServiceInstanceV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(CreateServiceInstanceV1, Procedure);

CreateServiceInstanceV1.prototype.summarize = function csiv1Summarize() {
    return this.changes.map(function (ch) {
        return sprintf('create "%s" service instance using image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};

CreateServiceInstanceV1.prototype.execute = function csiv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = opts.sdcadm;
    var progress = opts.progress;

    function createSvcInst(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            img: change.image,
            userScript: false,
            progress: progress,
            log: opts.log
        };
        var instances = [];
        var alias;

        var steps = [
            function validateTargetServer(_, next) {
                progress('Verifying target sever "%s" exists',
                        change.server);
                sdcadm.cnapi.getServer(change.server, function (sErr, serv) {
                    if (sErr) {
                        return next(sErr);
                    }
                    arg.server = serv.uuid;
                    return next();
                });
            },
            function getSvcInstances(_, next) {
                progress('Getting SDC\'s %s instances from SAPI',
                        change.service.name);
                sdcadm.sapi.listInstances({
                    service_uuid: change.service.uuid
                }, function (instErr, insts) {
                    if (instErr) {
                        return next(instErr);
                    }
                    // It doesn't really matter if we have no instances, the
                    // command could have failed creating the first one, and we
                    // may be trying to re-run from there
                    instances = insts;
                    return next();
                });
            },
            function generateInstanceAlias(_, next) {
                var n = change.service.name;
                progress('Calculating next %s instance alias', n);
                var nextId = instances.map(function (inst) {
                    return Number(inst.params.alias.replace(n, ''));
                }).sort().pop();
                nextId = nextId + 1;
                alias = n + nextId;
                next();
            }
        ];

        if (change.service.metadata) {  // workaround for assets (TOOLS-695)
            steps = steps.concat([
                s.getUserScript,
                s.writeOldUserScriptForRollback,
                s.updateSvcUserScript,
                s.updateSapiSvc
            ]);
        }

        steps.push(s.imgadmInstallRemote);

        steps.push(function createInstance(chg, next) {
            progress('Creating "%s" instance', alias);
            var iOpts = {
                params: {
                    alias: alias,
                    owner_uuid: sdcadm.config.ufds_admin_uuid,
                    server_uuid: change.server
                },
                metadata: {}
            };

            var svc = change.service.uuid;
            sdcadm.sapi.createInstance(svc, iOpts, function (err, inst_) {
                if (err) {
                    return next(
                        new errors.SDCClientError(err, 'sapi'));
                }
                progress('Instance "%s" (%s) created',
                    inst_.uuid, inst_.params.alias);

                chg.change.inst = {
                    alias: alias,
                    service: change.service.name,
                    zonename: inst_.uuid,
                    uuid: inst_.uuid
                };
                return next();
            });
        });

        steps.push(s.waitForInstToBeUp);
        opts.log.info({change: change},
                'CreateServiceInstanceV1 createSvcInst');
        vasync.pipeline({funcs: steps, arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: createSvcInst
    }, cb);

};


//---- exports

module.exports = {
    CreateServiceInstanceV1: CreateServiceInstanceV1
};
// vim: set softtabstop=4 shiftwidth=4:
