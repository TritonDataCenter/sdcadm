/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Collecting 'sdcadm post-setup ...' CLI commands.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;
var sprintf = require('extsprintf').sprintf;
var tabula = require('tabula');

var vasync = require('vasync');
var read = require('read');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;


var common = require('./common');
var errors = require('./errors');
var DownloadImages = require('./procedures/download-images').DownloadImages;
var shared = require('./procedures/shared');


//---- globals



//---- post-setup procedures

function Cloudapi() {}

Cloudapi.prototype.name = 'cloudapi';
Cloudapi.prototype.help = (
    'Create a first cloudapi instance.\n'
    + '\n'
    + 'Initial setup of SmartDataCenter does not create a cloudapi instance.\n'
    + 'This procedure will do that for you.\n'
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

    sdcadm.getInstances({}, onInstances);

    function onInstances(err, insts) {
        if (err) {
            return cb(err);
        }
        insts = insts.filter(function (svc) {
            if (svc.service === 'cloudapi') {
                return true;
            }
        });
        log.info({insts: insts}, '%d existing cloudapi insts', insts.length);
        if (insts.length === 1) {
            progress('Already have a cloudapi: vm %s (%s)',
                insts[0].instance, insts[0].alias);
            return cb();
        } else if (insts.length > 1) {
            progress('Already have %d cloudapi instances: vm %s (%s), ...',
                insts.length, insts[0].instance, insts[0].alias);
            return cb();
        }

        sdcadm.createCloudapiInstance({
            alias: 'cloudapi0',
            progress: progress
        }, cb);
    }
};

function CommonExternalNics() {}
CommonExternalNics.prototype.name = 'common-external-nics';
CommonExternalNics.prototype.help = (
    'Add external NICs to the adminui and imgapi zones.\n'
    + '\n'
    + 'By default no SDC core zones are given external nics in initial\n'
    + 'setup. Typically it is most useful to have those for the adminui\n'
    + 'instance (to be able to access the operator portal in your browser)\n'
    + 'and for the imgapi instance (to enable it to reach out to \n'
    + 'updates.joyent.com and images.joyent.com for images). IMGAPI\n'
    + 'instances are always firewalled such that only outbound connections\n'
    + 'are allowed.\n'
);
CommonExternalNics.prototype.execute = function (options, cb) {
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');

    var sdcadm = options.sdcadm;

    sdcadm.setupCommonExternalNics({
        progress: options.progress
    }, cb);
};



//---- PostSetup CLI class

function PostSetupCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm post-setup',
        desc: 'Common post-setup procedures.\n'
            + '\n'
            + 'The default setup of a SmartDataCenter headnode is somewhat\n'
            + 'minimal. "Everything up to adminui." Practical usage of\n'
            + 'SDC -- whether for production, development or testing --\n'
            + 'involves a number of common post-setup steps. This command\n'
            + 'attempts to capture many of those for convenience and\n'
            + 'consistency.\n',
        helpOpts: {
            minHelpCol: 26
        }
    });
}
util.inherits(PostSetupCLI, Cmdln);

PostSetupCLI.prototype.init = function init(opts, args, cb) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


PostSetupCLI.prototype.do_cloudapi =
function do_cloudapi(subcmd, opts, args, cb) {
    var self = this;
    var proc = new Cloudapi();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'cloudapi'}, true),
            progress: self.top.progress
        }, cb);
};
PostSetupCLI.prototype.do_cloudapi.help = (Cloudapi.prototype.help
    + '\n'
    + 'Usage:\n'
    + '     {{name}} cloudapi\n'
);

PostSetupCLI.prototype.do_common_external_nics =
function do_common_external_nics(subcmd, opts, args, cb) {
    var proc = new CommonExternalNics();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'common-external-nics'}, true),
            progress: this.progress
        }, cb);
};
PostSetupCLI.prototype.do_common_external_nics.help = (
    CommonExternalNics.prototype.help
    + '\n'
    + 'Usage:\n'
    + '     {{name}} common-external-nics\n'
);


/**
 * Add the 'zookeeper' service to the 'sdc' app in SAPI
 *
 */
PostSetupCLI.prototype.do_zookeeper =
function do_zookeeper(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var imgUUID = opts.image;

    var svcData = {
        name: 'zookeeper',
        params: {
            package_name: 'sdc_256',
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            networks: ['admin'],
            firewall_enabled: true,
            archive_on_delete: true,
            tags: {
                smartdc_role: 'zookeeper',
                smartdc_type: 'core'
            },
            delegate_dataset: true,
            cpu_shares: 256,
            cpu_cap: 150,
            zfs_io_priority: 10,
            max_lwps: 1000,
            max_physical_memory: 256,
            max_locked_memory: 256,
            max_swap: 512,
            quota: '25',
            // XXX can we skip these?
            //package_version: '1.0.0',
            //billing_id: 'TO_FILL_IN',
            customer_metadata: {}
        },
        metadata: {
            SERVICE_NAME: 'zookeeper',
            ZOOKEEPER_SERVICE : 'zookeeper.' + self.sdcadm.config.dns_domain,
            zookeeper_domain : 'zookeeper.' + self.sdcadm.config.dns_domain,
            'user-script': 'TO_FILL_IN'
        }
    };

    var img, haveImg, app, svc, hist;
    var changes = []; // used by history functions
    var arg = {}; // to pass to shared.js functions

    vasync.pipeline({arg: arg, funcs: [
        function getSdcApp(_, next) {
            self.sdcadm.sapi.listApplications({name: 'sdc'},
            function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }
                app = apps[0];
                return next();
            });
        },

        function getZkSvc(_, next) {
            self.sdcadm.sapi.listServices({
                name: 'zookeeper',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    return next(new errors.UsageError(
                            'zookeeper service already added to SDC'));
                }
                return next();
            });
        },

        // Either the given image UUID if exists or latest:
        function getImage(_, next) {
            var filter = {name: 'sdc-zookeeper'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    if (!imgUUID) {
                        img = images[images.length - 1]; //XXX presuming sorted
                    } else {
                        var filtered = images.filter(function (i) {
                            return (i.uuid === imgUUID);
                        });

                        if (!filtered.length) {
                            return next(new errors.UpdateError(
                            'no "sdc-zookeeper" image found with UUID %s',
                            imgUUID));
                        }

                        img = filtered[0];
                    }
                } else {
                    return next(new errors.UpdateError(
                            'no "sdc-zookeeper" image found'));
                }

                return next();
            });
        },

        function haveImageAlready(_, next) {
            self.sdcadm.imgapi.getImage(img.uuid, function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    haveImg = false;
                } else if (err) {
                    return next(err);
                } else {
                    haveImg = true;
                }
                return next();
            });
        },

        shared.getUserScript, // sets `arg.userScript`.

        // Here just b/c it'll be easier to deal with history this way:
        function prepareSvcData(_, next) {
            svcData.params.image_uuid = img.uuid;
            svcData.metadata['user-script'] = arg.userScript;
            next();
        },

        function saveChangesToHistory(_, next) {
            changes.push({
                service: svcData,
                type: 'add-service',
                image: img
            });

            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function importImage(_, next) {
            if (haveImg) {
                return next();
            }
            var proc = new DownloadImages({images: [img]});
            return proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        function createZkSvc(_, next) {
            self.progress('Creating "zookeeper" service');
            self.sdcadm.sapi.createService('zookeeper', app.uuid, svcData,
                    function (err, svc_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                svc = svc_;
                changes[0].service.uuid = svc.uuid;
                changes[0].service.application_uuid = svc.application_uuid;
                self.log.info({svc: svc}, 'created zookeeper svc');
                return next();
            });
        },

        function createZkInst(_, next) {
            self.progress('Creating "zookeeper" instance');
            var instOpts = {
                params: {
                    alias: 'zookeeper0'
                },
                metadata: {
                    ZK_ID: '0',
                    ZK_HA_SERVERS: []
                }
            };
            self.sdcadm.sapi.createInstance(svc.uuid, instOpts,
                    function (err, inst_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                // Note some of these values are not available when we first
                // create the instance, like ips or server_uuid. Those need
                // to be assigned during provisioning process.
                changes[0].inst = {
                    type: 'vm',
                    alias: inst_.alias,
                    version: img.version,
                    instance: inst_.uuid,
                    zonename: inst_.uuid,
                    service: 'zookeeper',
                    image: inst_.image_uuid
                };
                return next();
            });
        }
    ]}, function (err) {
        // Add error to history in case the update execution failed:
        if (err) {
            hist.error = err;
        }
        hist.changes = changes;
        // No need to add `history.finished` here, History instance will handle
        self.sdcadm.history.updateHistory(hist, function (err2, hist2) {
            if (err) {
                cb(err);
            } else if (err2) {
                cb(err2);
            } else {
                cb();
            }
        });
    });
};

PostSetupCLI.prototype.do_zookeeper.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'UUID of the specific image to use.'
    }
];

PostSetupCLI.prototype.do_zookeeper.help = (
    'Add the zookeeper service and switch SDC services to use it.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} zookeeper\n' +
    '\n' +
    '{{options}}'
);


PostSetupCLI.prototype.do_add_zookeeper =
function do_add_zookeeper(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (!opts.server) {
        return cb(new errors.UsageError('Target server uuid must be' +
                    'specified'));
    }

    var app, svc, instances, instanceId, image, server, hist;
    var changes = [];

    vasync.pipeline({funcs: [
        function checkTargetServer(_, next) {
            self.progress('Verifying target sever "%s" exists', opts.server);
            self.sdcadm.cnapi.getServer(opts.server, function (sErr, serv) {
                if (sErr) {
                    return next(sErr);
                }
                server = serv;
                return next();
            });
        },

        function getSdcApp(_, next) {
            self.progress('Getting SDC application details from SAPI');
            self.sdcadm.sapi.listApplications({ name: 'sdc' },
            function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }

                app = apps[0];
                return next();
            });
        },

        function getZkService(_, next) {
            self.progress('Getting SDC\'s zookeeper details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'zookeeper',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "zookeeper"'), 'sapi'));
                }
                svc = svcs[0];
                return next();
            });
        },

        function getZkInstances(_, next) {
            self.progress('Getting SDC\'s zookeeper instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }

                if (!insts.length) {
                    return next(new errors.SDCClientError(new Error(
                        'Unable to find first zookeeper instance'), 'sapi'));
                }

                instances = insts;
                return next();
            });
        },

        function getNextInstanceId(_, next) {
            self.progress('Figuring out next zk instance alias');
            instanceId = instances.map(function (inst) {
                return Number(inst.params.alias.replace('zookeeper', ''));
            }).sort().pop();
            instanceId = instanceId + 1;
            return next();
        },

        function getImageDetails(_, next) {
            var img = svc.params.image_uuid;
            self.sdcadm.imgapi.getImage(img, function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    return next(new errors.SDCClientError(new Error(
                        'No image with uuid "%s" found', img), 'imgapi'));
                } else if (err) {
                    return next(err);
                }
                image = img_;
                return next();
            });
        },

        function saveChangesToHistory(_, next) {
            changes.push({
                service: svc,
                image: image,
                type: 'add-instance',
                inst: {
                    type: 'vm',
                    alias: svc.name + instanceId,
                    version: image.version,
                    service: svc.name,
                    image: image.uuid,
                    server: server.uuid,
                    hostname: server.hostname
                }
            });

            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function createZkInst(_, next) {
            self.progress('Creating "zookeeper" instance');
            var instOpts = {
                params: {
                    alias: 'zookeeper' + instanceId
                },
                metadata: {
                    ZK_ID: String(instanceId),
                    ZK_HA_SERVERS: []
                }
            };
            self.sdcadm.sapi.createInstance(svc.uuid, instOpts,
                    function (err, inst_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                changes[0].inst.instance = inst_.uuid;
                changes[0].inst.zonename = inst_.uuid;
                return next();
            });
        }

    ]}, function (err) {
        // Add error to history in case the update execution failed:
        if (err) {
            hist.error = err;
        }
        hist.changes = changes;
        // No need to add `history.finished` here, History instance will handle
        self.sdcadm.history.updateHistory(hist, function (err2, hist2) {
            if (err) {
                cb(err);
            } else if (err2) {
                cb(err2);
            } else {
                self.progress('Done');
                cb();
            }
        });
    });

};


PostSetupCLI.prototype.do_add_zookeeper.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['server'],
        type: 'string',
        help: 'The UUID for the target server.'
    }
];

PostSetupCLI.prototype.do_add_zookeeper.help = (
    'Add another zk instance and reconfigure SDC services using it.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} add-zookeeper\n' +
    '\n' +
    '{{options}}'
);


PostSetupCLI.prototype.do_configure_zookeeper =
function do_configure_zookeeper(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var HA_ZK_JSON = [];
    var app, svc, instances, vms;

    var moraySvc, manateeSvc;
    var morayVms, manateeVms;
    var shard;

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.progress('Getting SDC application details from SAPI');
            self.sdcadm.sapi.listApplications({ name: 'sdc' },
            function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }

                app = apps[0];
                return next();
            });
        },

        function getZkService(_, next) {
            self.progress('Getting SDC\'s zookeeper details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'zookeeper',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "zookeeper"'), 'sapi'));
                }
                svc = svcs[0];
                return next();
            });
        },

        function getZkInstances(_, next) {
            self.progress('Getting SDC\'s zookeeper instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }

                if (!insts.length) {
                    return next(new errors.SDCClientError(new Error(
                        'Unable to find zookeeper instances'), 'sapi'));
                }

                if (insts.length !== 3 && insts.length !== 5) {
                    return next(new errors.UsageError(new Error(format(
                        'Invalid number of zookeeper instances (%s) ' +
                        'it must be either 3 or 5 in order to properly ' +
                        'configure the cluster',
                        insts.length)), 'sapi'));

                }
                instances = insts;
                return next();
            });
        },

        function getZkVms(_, next) {
            self.progress('Getting SDC\'s zookeeper vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'zookeeper',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                vms = vms_;
                return next();
            });
        },

        function cfgZkService(_, next) {
            vms.forEach(function (vm) {
                var instance = instances.filter(function (i) {
                    return (i.uuid === vm.uuid);
                })[0];

                HA_ZK_JSON.push({
                    host: vm.nics[0].ip,
                    port: 2181,
                    num: Number(instance.metadata.ZK_ID)
                });
            });

            // Set a value for special property "last" for just the final
            // element of the collection
            HA_ZK_JSON[HA_ZK_JSON.length - 1].last = true;

            self.progress('Updating ZK service config in SAPI');
            self.sdcadm.sapi.updateService(svc.uuid, {
                metadata: {
                    ZK_HA_SERVERS: HA_ZK_JSON
                }
            }, function (upErr) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function cfgZkInstances(_, next) {
            self.progress('Updating ZK instances config in SAPI');
            vasync.forEachPipeline({
                inputs: instances,
                func: function upZkInst(it, next_) {
                    self.sdcadm.sapi.updateInstance(it.uuid, {
                        action: 'delete',
                        metadata: {
                            ZK_HA_SERVERS: []
                        }
                    }, function (itErr) {
                        if (itErr) {
                            return next_(itErr);
                        }
                        return next_();
                    });
                }
            }, function callback(upErr, results) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function waitForZkClusterOk(_, next) {
            self.progress('Waiting for ZK cluster to reach a steady state');
            var ips = vms.map(function (vm) {
                return (vm.nics[0].ip);
            });

            shared.wait4ZkOk({
                ips: ips,
                log: self.sdcadm.log
            }, next);
        },

        function checkAllInstancesJoinedZkCluster(_, next) {
            self.progress('Waiting for zk instances to join ZK cluster');
            var ips = vms.map(function (vm) {
                return (vm.nics[0].ip);
            });

            shared.wait4ZkCluster({
                ips: ips,
                log: self.sdcadm.log
            }, next);
        },

        function getMorayService(_, next) {
            self.progress('Getting SDC\'s moray details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'moray',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "moray"'), 'sapi'));
                }
                moraySvc = svcs[0];
                return next();
            });
        },


        function getManateeService(_, next) {
            self.progress('Getting SDC\'s manatee details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'manatee',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "zookeeper"'), 'sapi'));
                }
                manateeSvc = svcs[0];
                return next();
            });
        },


        function cfgMoraySvc(_, next) {
            self.progress('Updating Moray service config in SAPI');
            self.sdcadm.sapi.updateService(moraySvc.uuid, {
                metadata: {
                    ZK_HA_SERVERS: HA_ZK_JSON
                }
            }, function (upErr) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function getMorayVms(_, next) {
            self.progress('Getting SDC\'s moray vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'moray',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                morayVms = vms_;
                return next();
            });
        },

        function cfgManateeSvc(_, next) {
            self.progress('Updating Manatee service config in SAPI');
            self.sdcadm.sapi.updateService(manateeSvc.uuid, {
                metadata: {
                    ZK_HA_SERVERS: HA_ZK_JSON
                }
            }, function (upErr) {
                if (upErr) {
                    return next(upErr);
                }
                return next();
            });
        },

        function getManateeVms(_, next) {
            self.progress('Getting SDC\'s manatees vms from VMAPI');
            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'manatee',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                manateeVms = vms_;
                return next();
            });
        },

        function getShard(_, next) {
            self.progress('Getting manatee shard status');
            var vm = manateeVms[0];

            shared.getShardStatus({
                server: vm.server_uuid,
                manateeUUID: vm.uuid,
                log: self.sdcadm.log
            }, function (err, st) {
                if (err) {
                    return next(err);
                }
                shard = st;
                // Also set server uuid for each one of the manatees on the
                // shard to simplify next steps:
                manateeVms.forEach(function (v) {
                    if (shard.sdc.primary.zoneId === v.uuid) {
                        shard.sdc.primary.server = v.server_uuid;
                    } else if (shard.sdc.sync &&
                        shard.sdc.sync.zoneId === v.uuid) {
                        shard.sdc.sync.server = v.server_uuid;
                    } else if (shard.sdc.async &&
                        shard.sdc.async.zoneId === v.uuid) {
                        shard.sdc.async.server = v.server_uuid;
                    }
                });
                return next();
            });
        },

        function disableManatee(_, next) {
            shared.disableManateeSitter({
                progress: self.progress,
                log: self.sdcadm.log,
                shard: shard
            }, next);
        },

        function enableManatee(_, next) {
            shared.enableManateeSitter({
                progress: self.progress,
                log: self.sdcadm.log,
                shard: shard
            }, next);
        },

        function restartMorays(_, next) {
            self.progress('Restarting moray services');
            vasync.forEachParallel({
                inputs: morayVms,
                func: function restartMoray(vm, next_) {
                    shared.restartRemoteSvc({
                        server: vm.server_uuid,
                        zone: vm.uuid,
                        fmri: '*moray-202*',
                        log: self.sdcadm.log
                    }, next_);
                }
            }, function (morErr, morRes) {
                if (morRes) {
                    return next(morErr);
                }
                return next();
            });
        }
    ]}, function (err) {
        if (err) {
            console.error(err);
        }
        self.progress('Moray services have been restarted.\n' +
                'It may take some time to services talking to moray ' +
                'to reconnect.');
        self.progress('Done');
        cb();
    });

};
PostSetupCLI.prototype.do_configure_zookeeper.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

PostSetupCLI.prototype.do_configure_zookeeper.help = (
    'Configure zookeeper service and switch SDC services to use it.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} configure-zookeeper\n' +
    '\n' +
    '{{options}}'
);
//---- exports

module.exports = {
    PostSetupCLI: PostSetupCLI
};
