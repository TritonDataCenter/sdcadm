/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */
/*
 * `sdcadm post-setup cmon`
 */

var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var assert = require('assert-plus');
var ProgressBar = require('progbar').ProgressBar;

var errors = require('../errors'),
    SDCClientError = errors.SDCClientError,
    UpdateError = errors.UpdateError,
    MultiError = errors.MultiError;
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var common = require('../common');
var steps = require('../steps');


function do_cmon(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    // Progress bar
    var bar;
    var completed = 0;
    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    var errs = [];

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
        sdcadm: self.sdcadm,
        imgsToDownload: [],
        didSomething: false,
        serversToUpdate: null,
        urConnection: null,
        serverFromUuidOrHostname: {}
    };

    vasync.pipeline({arg: context, funcs: [
        steps.sapiAssertFullMode,

        function ensureCnsSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cns',
                application_uuid: self.sdcadm.sdc.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                } else if (!svcs.length) {
                    next(new errors.UpdateError(
                        'The CNS service is required by CMON.\n' +
                        common.indent('Please, install it with ' +
                            '`sdcadm post-setup cns`.')));
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
            if (ctx.cmonInst) {
                next();
                return;
            }
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
            if (ctx.cmonInst) {
                next();
                return;
            }
            self.sdcadm.imgapi.getImage(ctx.cmonImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.cmonImg);
                    next();
                } else if (err) {
                    next(err);
                } else {
                    next();
                }
            });
        },

        function haveCmonAgentImageAlready(ctx, next) {
            self.sdcadm.imgapi.listImages({
                name: 'cmon-agent'
            }, function (err, images) {
                if (err) {
                    next(err);
                    return;
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.cmonAgentImg = images[images.length - 1];
                }
                next();
            });
        },

        function getLatestCmonAgentImage(ctx, next) {
            if (ctx.cmonAgentImg) {
                next();
                return;
            }
            var filter = {name: 'cmon-agent'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.cmonAgentImg = images[images.length - 1];
                    ctx.imgsToDownload.push(ctx.cmonAgentImg);
                    next();
                } else {
                    next(new errors.UpdateError(
                                'no "cmon-agent" image found'));
                }
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
            svcData.metadata.SERVICE_DOMAIN = svcDomain;
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
            self.sdcadm.getCurrServerUuid(function (err, hn) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.headnodeUuid = hn;
                next();
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
                    server_uuid: ctx.headnodeUuid
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

        function getOrCreateCmonAgentSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cmon-agent'
            }, function (err, svcs) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }

                if (svcs.length) {
                    ctx.cmonAgentSvc = svcs[0];
                    next();
                    return;
                }
                self.progress('Creating "cmon-agent" service');
                self.sdcadm.sapi.createService('cmon-agent',
                        self.sdcadm.sdc.uuid, {
                    params: {
                        image_uuid: ctx.cmonAgentImg.uuid,
                        tags: {
                            smartdc_role: 'cmon-agent',
                            smartdc_type: 'core'
                        }
                    },
                    metadata: {
                        SERVICE_NAME: 'cmon-agent'
                    },
                    type: 'agent'
                }, function (er2, service) {
                    if (er2) {
                        next(new errors.SDCClientError(er2, 'sapi'));
                        return;
                    }
                    ctx.cmonAgentSvc = service;
                    next();
                    return;
                });
            });
        },

        function findServersToUpdate(ctx, next) {
            self.sdcadm.cnapi.listServers({
                extras: 'agents'
            }, function (err, servers) {
                if (err) {
                    next(err);
                    return;
                }
                var i;
                for (i = 0; i < servers.length; i++) {
                    ctx.serverFromUuidOrHostname[servers[i].uuid] = servers[i];
                    ctx.serverFromUuidOrHostname[servers[i].hostname] =
                        servers[i];
                }

                if (opts.servers && opts.servers.length > 0) {
                    ctx.serversToUpdate = opts.servers.map(function (s) {
                        return ctx.serverFromUuidOrHostname[s];
                    }).filter(function (x) {
                        return x !== undefined && x !== null;
                    });

                    var unsetup = [];
                    ctx.serversToUpdate.forEach(function (s) {
                        if (!s.setup) {
                            unsetup.push(s.uuid);
                        }
                    });

                    if (unsetup.length) {
                        next(new UpdateError(format(
                            'The following servers are not setup:\n%s\n' +
                            'Please make sure to setup these servers ' +
                            'or remove them from the list of servers to ' +
                            'update.',
                            unsetup.join(','))));
                        return;
                    }
                } else {
                    ctx.serversToUpdate = servers.filter(function (svr) {
                        return svr.setup;
                    });
                }

                var notRunning = [];
                ctx.serversToUpdate.forEach(function (srv) {
                    if (srv.status !== 'running' ||
                        (srv.status === 'running' &&
                         srv.transitional_status !== '')) {
                        notRunning.push(srv.uuid);
                    }
                });
                if (notRunning.length) {
                    next(new UpdateError(format(
                        'The following servers are not running:\n%s\n' +
                        'Please make sure of these servers are running ' +
                        'or remove them from the list of servers to ' +
                        'update.', notRunning.join(','))));
                    return;
                }

                // Silently skip servers where we've already setup cmon-agent:
                ctx.serversToUpdate = ctx.serversToUpdate.filter(function (s) {
                    return !s.agents.some(function (a) {
                        return (a.name === 'cmon-agent');
                    });
                });

                next();
            });
        },

        function updateAgentOnServers(ctx, next) {
            if (!ctx.serversToUpdate.length) {
                self.progress(
                        '"cmon-agent" is already installed on all servers.');
                next();
                return;
            }

            if (process.stderr.isTTY) {
                bar = new ProgressBar({
                    size: ctx.serversToUpdate.length,
                    bytes: false,
                    filename: 'Installing cmon-agent'
                });
                bar.advance(0); // Draw initial progbar at 0.
            }

            ctx.didSomething = true;

            // Check task completion by taskid
            function waitUntilTaskCompletes(taskid, _cb) {
                var counter = 0;
                var limit = 60;
                function _waitTask() {
                    counter += 1;
                    self.sdcadm.cnapi.getTask(taskid, function (err, task) {
                        if (err) {
                            _cb(new SDCClientError(err, 'cnapi'));
                            return;
                        }

                        if (task.status === 'failure') {
                            var msg = format('Task %s failed', taskid);
                            if (task.history[0].event.error) {
                                msg += ' with error: ' +
                                    task.history[0].event.error.message;
                            }
                            _cb(new UpdateError(msg));
                        } else if (task.status === 'complete') {
                            _cb();
                        } else if (counter < limit) {
                            setTimeout(_waitTask, 5000);
                        } else {
                            var message = format(
                                'Timeout (5m) waiting for task %s', taskid);
                            self.progress(message);
                            _cb(new UpdateError(message));
                        }
                    });
                }
                _waitTask();
            }

            function installAgent(server, callback) {
                self.log.debug({
                    server: server.uuid
                }, 'Installing cmon-agent instance');

                self.sdcadm.cnapi.post({
                    path: format('/servers/%s/install-agent', server.uuid)
                }, {
                    image_uuid: ctx.cmonAgentImg.uuid
                }, function cnapiCb(er2, res) {
                    if (er2) {
                        callback(new SDCClientError(er2, 'cnapi'));
                        return;
                    }

                    self.log.debug({
                        svc: 'cmon-agent',
                        server: server.uuid,
                        image: ctx.cmonAgentImg.uuid,
                        taskId: res.id
                    }, 'Waiting for install_agent task to complete');

                    waitUntilTaskCompletes(res.id, function (er3) {
                        if (er3) {
                            errs.push(er3);
                        }
                        self.log.debug({
                            err: er3,
                            taskId: res.id,
                            svc: 'cmon-agent',
                            server: server.uuid
                        }, 'agent_install task completed');
                        callback();
                    });
                });
            }

            var queue = vasync.queue(installAgent, opts.concurrency);
            queue.push(ctx.serversToUpdate, function doneOne() {
                if (bar) {
                    completed += 1;
                    bar.advance(completed);
                }
            });
            queue.close();
            queue.on('end', function queueDone() {
                if (bar) {
                    bar.end();
                }
                if (errs.length) {
                    self.progress(
                        '"cmon-agent" install failed on %d server%s.',
                        errs.length, (errs.length > 1 ? 's' : ''));
                    next(new MultiError(errs));
                } else {
                    self.progress(
                        'Successfully installed "cmon-agent" on all servers.');
                    next();
                }
            });
        },

        function done(ctx, next) {
            if (ctx.didSomething) {
                self.progress('Setup "CMON" (%ds)',
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
        help: 'Update channel from which to get the "cmon" and ' +
            '"cmon-agent" images.',
        helpArg: 'CHANNEL'
    },
    {
        names: ['concurrency', 'j'],
        type: 'integer',
        'default': 5,
        help: 'Number of concurrent servers to which to install cmon-agent' +
            ' simultaneously. Default: 5',
        helpArg: 'N'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfCommaSepString',
        help: 'Comma-separate list of servers (hostname or UUID) on which ' +
            'cmon-agent will be setup. If not specified, then cmon-agent ' +
            'will be setup on all setup servers.'
    }
];
do_cmon.help = (
    'Setup the Container Monitor (CMON) system.\n' +
    '\n' +
    'This command will setup the "cmon" and "cmon-agent" services\n' +
    'and create an initial instance of "cmon" on the headnode and\n' +
    '"cmon-agent" on the specify (or all setup) servers.\n' +
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
