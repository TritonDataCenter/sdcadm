/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Collecting 'sdcadm experimental ...' CLI commands.
 *
 * These are temporary, unsupported commands for running SDC updates before
 * the grand plan of 'sdcadm update' fully handling updates is complete.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;

var vasync = require('vasync');
var read = require('read');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;

var common = require('./common');
var errors = require('./errors');
var DownloadImages = require('./procedures/download-images').DownloadImages;
var shared = require('./procedures/shared');
var defFabric = require('./default-fabric');
var fabrics = require('./fabrics');
var svcadm = require('./svcadm');
var ur = require('./ur');



//---- globals



//---- Experimental CLI class

function ExperimentalCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm experimental',
        desc: 'Experimental, unsupported, temporary sdcadm commands.\n' +
              '\n' +
              'These are unsupported and temporary commands to assist with\n' +
              'migration away from incr-upgrade scripts. The eventual\n' +
              'general upgrade process will not include any commands under\n' +
              '"sdcadm experimental".',
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        }
    });
}
util.inherits(ExperimentalCLI, Cmdln);

ExperimentalCLI.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


/*
 * Update agents in datancenter with a given or latest agents installer.
 */
ExperimentalCLI.prototype.do_update_agents =
function do_update_agents(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (!opts.latest && !args[0]) {
        return cb(new errors.UsageError(
            'must specify installer image UUID or --latest'));
    }

    return self.sdcadm.updateAgents({
        image: (opts.latest) ? 'latest' : args[0],
        progress: self.progress,
        justDownload: opts.just_download,
        force: opts.force,
        yes: opts.yes
    }, cb);
};
ExperimentalCLI.prototype.do_update_agents.help = (
    'Update SDC agents\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-agents IMAGE-UUID\n' +
    '     {{name}} update-agents PATH-TO-INSTALLER\n' +
    '     {{name}} update-agents --latest\n' +
    '\n' +
    '{{options}}'
);
ExperimentalCLI.prototype.do_update_agents.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published agents installer.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the agents installer for later usage.'
    },
    {
        names: ['force'],
        type: 'bool',
        help: 'Re-run the agents installer even if it was run before'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    }
];



ExperimentalCLI.prototype.do_dc_maint =
function do_dc_maint(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (opts.start && opts.stop) {
        cb(new errors.UsageError('cannot use --start and --stop'));
    } else if (opts.start) {
        this.sdcadm.dcMaintStart({progress: self.progress}, cb);
    } else if (opts.stop) {
        this.sdcadm.dcMaintStop({progress: self.progress}, cb);
    } else {
        this.sdcadm.dcMaintStatus(function (err, status) {
            if (err) {
                return cb(err);
            }
            if (opts.json) {
                self.progress(JSON.stringify(status, null, 4));
            } else if (status.maint) {
                if (status.startTime) {
                    self.progress('DC maintenance: on (since %s)',
                        status.startTime);
                } else {
                    self.progress('DC maintenance: on');
                }
            } else {
                self.progress('DC maintenance: off');
            }
            cb();
        });
    }
};
ExperimentalCLI.prototype.do_dc_maint.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show status as JSON.'
    },
    {
        names: ['start'],
        type: 'bool',
        help: 'Start maintenance mode.'
    },
    {
        names: ['stop'],
        type: 'bool',
        help: 'Stop maintenance mode (i.e. restore DC to full operation).'
    }
];
ExperimentalCLI.prototype.do_dc_maint.help = (
    'Show and modify the DC maintenance mode.\n' +
    '\n' +
    '"Maintenance mode" for an SDC means that Cloud API is in read-only\n' +
    'mode. Modifying requests will return "503 Service Unavailable".\n' +
    'Workflow API will be drained on entering maint mode.\n' +
    '\n' +
    'Limitation: This does not current wait for config changes to be made\n' +
    'and cloudapi instances restarted. That means there is a window after\n' +
    'starting that new jobs could come in.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} dc-maint [-j]           # show DC maint status\n' +
    '     {{name}} dc-maint [--start]      # start DC maint\n' +
    '     {{name}} dc-maint [--stop]       # stop DC maint\n' +
    '\n' +
    '{{options}}'
);


/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-other.sh".
 */
ExperimentalCLI.prototype.do_update_other =
function do_update_other(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var app, caInst, caSvc, domain, regionName, sapiUrl, services;
    var binderSvc, binderVms;
    // Used by history:
    var history;
    var changes = [];

    // Helper functions

    function updateService(uuid, svcOpts, next) {
        self.sdcadm.sapi.updateService(uuid, svcOpts, function (err, svc) {
            if (err) {
                return next(new errors.SDCClientError(err, 'sapi'));
            }
            next();
        });
    }

    function updateApplication(svcOpts, next) {
        self.sdcadm.sapi.updateApplication(app.uuid, svcOpts,
        function (err, svc) {
            if (err) {
                return next(new errors.SDCClientError(err, 'sapi'));
            }
            next();
        });
    }

    function readField(field, default_, cbRead) {
        if (cbRead === undefined) {
            cbRead = default_;
            default_ = undefined;
        }
        assert.object(field, 'field');
        assert.func(cbRead);

        var readOpts = {
            prompt: field.name + ':',
            silent: field.hidden,
            default: default_
        };

        read(readOpts, function (rErr, val) {
            if (rErr) {
                return cbRead(rErr);
            }

            val = val.trim();
            if (!field.confirm) {
                return cbRead(null, val);
            }

            readOpts.prompt = field.name + ' confirm:';
            read(readOpts, function (rErr2, val2) {
                if (rErr2) {
                    return cbRead(rErr2);
                }

                val2 = val2.trim();
                if (val !== val2) {
                    cbRead(new Error(format(
                        '%s values do not match', field.name)));
                } else {
                    cbRead(null, val);
                }
            });
        });
    }

    // TODO move to some place where it can be reused
    function mountUsbKey(_, cbMount) {
        execFile('/usbkey/scripts/mount-usb.sh', cbMount);
    }

    // TODO move to some place where it can be reused
    function unmountUsbKey(_, cbMount) {
        execFile('/usr/sbin/umount', [ '/mnt/usbkey' ], cbMount);
    }

    // Upgrade pipeline

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            app = self.sdcadm.sdc;
            domain = app.metadata.datacenter_name + '.' +
                app.metadata.dns_domain;
            sapiUrl = app.metadata['sapi-url'];

            return next();
        },

        function getServices(_, next) {
            self.sdcadm.getServices({}, function (err, svcs) {
                if (err) {
                    return next(err);
                }

                services = svcs;
                // Locate CA & Binder for later
                svcs.forEach(function (svc) {
                    if (svc.name === 'ca') {
                        caSvc = svc;
                    } else if (svc.name === 'binder') {
                        binderSvc = svc;
                    }
                });

                return next();
            });
        },

        function saveChangesToHistory(_, next) {
            services.forEach(function (svc) {
                if (svc.type === 'vm') {
                    changes.push({
                        service:  svc,
                        type: 'update-service-cfg'
                    });
                }
            });
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                history = hst;
                return next();
            });
        },

        function updateMaintainResolvers(_, next) {
            progress('Updating maintain_resolvers for all vm services');

            function updateSvc(svc, nextSvc) {
                if (svc.type === 'vm' && svc.params &&
                    svc.params.maintain_resolvers !== true) {
                    updateService(svc.uuid,
                        { params: { maintain_resolvers: true } },
                        nextSvc);
                    return;
                }
                return nextSvc();
            }

            vasync.forEachParallel({
                inputs: services,
                func: updateSvc
            }, next);
        },

        function updateServiceDomains(_, next) {
            var SERVICES = ['papi', 'mahi'];
            progress('Updating DNS domain service metadata for %s',
                SERVICES.join(', '));

            function updateSvc(svc, nextSvc) {
                if (SERVICES.indexOf(svc.name) !== -1) {
                    var svcDomain = svc.name + '.' + domain;

                    updateService(svc.uuid,
                        { metadata: {
                            SERVICE_DOMAIN: svcDomain,
                            'sapi-url': sapiUrl
                        } },
                        nextSvc);
                    return;
                }
                return nextSvc();
            }

            vasync.forEachParallel({
                inputs: services,
                func: updateSvc
            }, next);
        },
        function updateAppDomains(_, next) {
            var SERVICES = ['papi', 'mahi'];
            progress('Updating DNS domain SDC application metadata for %s',
                SERVICES.join(', '));

            function updateApp(svc, nextSvc) {
                if (SERVICES.indexOf(svc.name) !== -1) {
                    var svcDomain = svc.name + '.' + domain;
                    var metadata = {};
                    metadata[svc.name.toUpperCase() + '_SERVICE'] = svcDomain;
                    metadata[svc.name + '_domain'] = svcDomain;

                    updateApplication({ metadata: metadata }, nextSvc);
                    return;
                }
                return nextSvc();
            }

            vasync.forEachParallel({
                inputs: services,
                func: updateApp
            }, next);
        },
        function updateCaParams(_, next) {
            function getCaInstance(__, next_) {
                var filters = {
                    state: 'active',
                    owner_uuid: self.sdcadm.config.ufds_admin_uuid,
                    alias: 'ca0'
                };

                self.sdcadm.vmapi.listVms(filters, function (vmsErr, vms) {
                    if (vmsErr) {
                        return next_(vmsErr);
                    }

                    caInst = vms[0];
                    return next_();
                });
            }

            function updateCaService(__, next_) {
                if (caSvc.params.max_physical_memory >= 4096) {
                    return next_();
                }

                progress('Updating CA service\'s max_physical_memory value');

                var params = {
                    max_physical_memory: 4096,
                    max_locked_memory: 4096,
                    max_swap: 8192,
                    zfs_io_priority: 20,
                    cpu_cap: 400,
                    package_name: 'sdc_4096'
                };

                updateService(caSvc.uuid, { params: params }, next_);
            }

            function updateCaInstance(__, next_) {
                if (caInst.max_physical_memory >= 4096) {
                    return next_();
                }

                progress('Updating CA\'s ca0 instance ' +
                        'max_physical_memory value');
                var argv = [
                    '/usr/sbin/vmadm',
                    'update',
                    caInst.uuid,
                    'max_physical_memory=4096',
                    'max_locked_memory=4096',
                    'max_swap=8192',
                    'zfs_io_priority=20',
                    'cpu_cap=400'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next_);
            }

            vasync.pipeline({
                funcs: [getCaInstance, updateCaService, updateCaInstance]
            }, next);
        },
        function updateRegionName(_, next) {
            fs.readFile('/usbkey/config', {
                encoding: 'utf8'
            }, function (err, data) {
                if (err) {
                    return next(err);
                /* JSSTYLED */
                } else if (data.search(/region_name=/) !== -1) {
                    progress('No need to update region_name for ' +
                        'this data center');
                    return next();
                }

                function readRegionName(__, next_) {
                    progress('Updating region_name for this data center');

                    var field = {
                        name: 'region_name',
                        hidden: false,
                        confirm: true
                    };
                    readField(field, function (err1, value) {
                        if (err1) {
                            return next_(err1);
                        }

                        regionName = value;
                        return next_();
                    });
                }

                function appendRegionName(__, next_) {
                    var region = 'region_name=' + regionName + '\n';
                    fs.appendFile('/mnt/usbkey/config', region,
                            function (err1) {
                        if (err1) {
                            return next_(err1);
                        }

                        var argv = [
                            '/usr/bin/cp',
                            '/mnt/usbkey/config',
                            '/usbkey/config'
                        ];
                        common.execFilePlus({argv: argv, log: self.log}, next_);
                    });
                }

                function updateSapiRegionName(__, next_) {
                    var metadata = { region_name: regionName };
                    updateApplication({ metadata: metadata }, next_);
                }

                vasync.pipeline({funcs: [
                    readRegionName,
                    mountUsbKey,
                    appendRegionName,
                    unmountUsbKey,
                    updateSapiRegionName
                ]}, next);
            });
        },
        function addSapiDomainToNodeConfig(_, next) {
            var nodeConfig = '/usbkey/extra/joysetup/node.config';
            var sapiDomain = 'sapi_domain=\'sapi.' + domain + '\'\n';

            fs.readFile(nodeConfig, { encoding: 'utf8' }, function (err, data) {
                if (err) {
                    return next(err);
                /* JSSTYLED */
                } else if (data.search(/sapi_domain=/) !== -1) {
                    progress('sapi_domain already present on node.config');
                    return next();
                }

                progress('Appending sapi_domain to node.config');
                fs.appendFile(nodeConfig, sapiDomain, next);
            });
        },
        function updateBinder(_, next) {

            function vmUpdateRemote(uuid, server, cb_) {
                assert.string(uuid, 'uuid');
                assert.string(server, 'server');
                assert.func(cb_, 'cb_');

                var argv = [
                    '/opt/smartdc/bin/sdc-oneachnode',
                    format('-n %s ', server),
                    '-j',
                    format('/usr/sbin/vmadm update %s ' +
                        'max_physical_memory=1024; ' +
                        '/usr/sbin/vmadm update %s ' +
                        'max_locked_memory=1024; ' +
                        '/usr/sbin/vmadm update %s ' +
                        'max_swap=2048;', uuid, uuid, uuid)
                ];
                var env = common.objCopy(process.env);
                var execOpts = {
                    encoding: 'utf8',
                    env: env
                };

                function execFileCb(err, stdout, stderr) {
                    if (err) {
                        var msg = format(
                            'error Updating VM %s:\n' +
                            '\targv: %j\n' +
                            '\texit status: %s\n' +
                            '\tstdout:\n%s\n' +
                            '\tstderr:\n%s', uuid,
                            argv, err.code, stdout.trim(), stderr.trim());
                        return cb_(new errors.InternalError({
                            message: msg,
                            cause: err
                        }));
                    }
                    var res = JSON.parse(stdout);

                    if (!res.length || !res[0].result) {
                        self.sdcadm.log.error({
                            res: res
                        }, 'vmadm update result');
                        return cb_('Unexpected vmadm update output');
                    }

                    if (res[0].result.exit_status !== 0) {
                        self.sdcadm.log.error({
                            result: res[0].result
                        }, 'vmadm update result');

                        return cb_('vmadm update exited with status %d',
                                res[0].result.exit_status);
                    }

                    cb_(null);
                }

                self.sdcadm.log.trace({argv: argv}, 'Updating VM');
                execFile(argv[0], argv.slice(1), execOpts, execFileCb);
            }

            function updateBinderService(__, next_) {
                if (binderSvc.params.max_physical_memory >= 1024) {
                    progress('binder service\'s max_physical_memory' +
                        ' is up2date');
                    return next_();
                }

                progress('Updating binder service\'s max_physical_memory' +
                        ' value');

                var params = {
                    max_physical_memory: 1024,
                    max_locked_memory: 1024,
                    max_swap: 2048
                };

                updateService(binderSvc.uuid, { params: params }, next_);
            }

            progress('Getting SDC\'s binder vms from VMAPI');

            self.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'binder',
                state: 'running'
            }, function (vmsErr, vms_) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                binderVms = vms_;

                var funcs = [updateBinderService];

                binderVms.forEach(function (vm) {
                    funcs.push(function (__, next_) {
                        if (vm.max_physical_memory >= 1024) {
                            progress('%s is up2date', vm.alias);
                            return next_();
                        }
                        progress('Updating %s max_physical_memory', vm.alias);
                        return vmUpdateRemote(vm.uuid, vm.server_uuid, next_);
                    });
                });

                return vasync.pipeline({funcs: funcs}, next);
            });

        }
    ]}, function (err) {
        if (!history) {
            self.sdcadm.log.warn('History not set for update-other');
            return cb(err);
        }

        if (err) {
            history.error = err;
        }
        self.sdcadm.history.updateHistory(history, function (err2) {
            if (err) {
                return cb(err);
            }
            progress('Done.');
            if (err2) {
                return cb(err2);
            } else {
                return cb();
            }
        });
    });
};
ExperimentalCLI.prototype.do_update_other.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
ExperimentalCLI.prototype.do_update_other.help = (
    'Temporary grabbag for small SDC update steps.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-other\n' +
    '\n' +
    '{{options}}'
);

/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-tools.sh".
 */
ExperimentalCLI.prototype.do_update_gz_tools =
function do_update_gz_tools(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var execStart = Date.now();

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    function finish(err) {
        if (err) {
            return cb(err);
        }
        progress('Updated gz-tools successfully (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        return cb();
    }

    if (!opts.latest && !args[0]) {
        return finish(new errors.UsageError(
            'must specify installer image UUID or --latest'));
    }

    self.sdcadm.updateGzTools({
        image: opts.latest ? 'latest' : args[0],
        progress: progress,
        justDownload: opts.just_download
    }, finish);

};
ExperimentalCLI.prototype.do_update_gz_tools.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published gz-tools installer.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the GZ Tools installer for later usage.'
    }
];
ExperimentalCLI.prototype.do_update_gz_tools.help = (
    'Temporary grabbag for updating the SDC global zone tools.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-gz-tools IMAGE-UUID\n' +
    '     {{name}} update-gz-tools PATH-TO-INSTALLER\n' +
    '     {{name}} update-gz-tools --latest\n' +
    '\n' +
    '{{options}}'
);


ExperimentalCLI.prototype.do_add_new_agent_svcs =
function do_add_new_agents_svcs(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var execStart = Date.now();

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    // We need at least a MIN_VALID_SAPI_VERSION image so
    // type=agent suport is there.
    var MIN_VALID_SAPI_VERSION = '20140703';
    var app = self.sdcadm.sdc;

    var svc, inst, vm, img;
    var agentNames = ['vm-agent', 'net-agent', 'cn-agent',
        'agents_core',
        'amon-agent', 'amon-relay', 'cabase', 'cainstsvc', 'config-agent',
        'firewaller', 'hagfish-watcher', 'smartlogin'
    ];
    var agentServices = {};
    agentNames.forEach(function (n) {
        var logLevelKey = n.toUpperCase().replace('-', '_') + '_LOG_LEVEL';
        agentServices[n] = {
            type: 'agent',
            params: {
                tags: {
                    smartdc_role: n,
                    smartdc_type: 'core'
                }
            },
            metadata: {
                SERVICE_NAME: n
            },
            manifests: {
            }
        };

        agentServices[n].metadata[logLevelKey] = 'info';
    });

    var newAgentServices = [];
    // Used by history:
    var history;
    var changes = [];

    vasync.pipeline({funcs: [
        function getSapiService(_, next) {
            progress('Getting SDC\'s SAPI service details from SAPI');
            self.sdcadm.sapi.listServices({
                name: 'sapi',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                }
                if (!svcs.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No services named "manatee"'), 'sapi'));
                }
                svc = svcs[0];
                return next();
            });
        },

        function getSapiInstance(_, next) {
            progress('Getting SDC\'s sapi instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }

                if (!insts.length) {
                    return next(new errors.SDCClientError(new Error(
                        'Unable to find first sapi instance'), 'sapi'));
                }

                inst = insts[0];
                return next();
            });
        },

        function getSapiVm(_, next) {
            progress('Getting sapi VM details from VMAPI');
            self.sdcadm.vmapi.getVm({uuid: inst.uuid}, function (vmErr, obj) {
                if (vmErr) {
                    return next(vmErr);
                }
                vm = obj;
                return next();
            });
        },

        function getSapiImage(_, next) {
            progress('Getting sapi Image details from IMGAPI');
            self.sdcadm.imgapi.getImage(vm.image_uuid, function (imgErr, obj) {
                if (imgErr) {
                    return next(imgErr);
                }
                img = obj;
                return next();
            });
        },

        function checkMinSapiVersion(_, next) {
            progress('Checking for minimum SAPI version');
            var splitVersion = img.version.split('-');
            var validSapi = false;

            if (splitVersion[0] === 'master') {
                validSapi = splitVersion[1].substr(0, 8) >=
                    MIN_VALID_SAPI_VERSION;
            } else if (splitVersion[0] === 'release') {
                validSapi = splitVersion[1] >= MIN_VALID_SAPI_VERSION;
            }

            if (!validSapi) {
                return next(new errors.SDCClientError(new Error('Datacenter ' +
                    'does not have the minimum SAPI version needed for adding' +
                    ' service agents. ' +
                    'Please, try again after upgrading SAPI')));
            }

            return next();
        },

        function checkExistingAgents(_, next) {
            vasync.forEachParallel({
                func: function checkAgentExist(agent, callback) {
                    progress('Checking if service \'%s\' exists', agent);
                    self.sdcadm.sapi.listServices({
                        name: agent,
                        type: 'agent',
                        application_uuid: app.uuid
                    }, function (svcErr, svcs) {
                        if (svcErr) {
                            return callback(svcErr);
                        }
                        if (!svcs.length) {
                            newAgentServices.push(agent);
                        }
                        return callback();
                    });
                },
                inputs: Object.keys(agentServices)
            }, function (err) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        },
        function saveChangesToHistory(_, next) {
            newAgentServices.forEach(function (s) {
                changes.push({
                    service: {
                        name: s,
                        type: 'agent'
                    },
                    type: 'create-service'
                });

            });
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                history = hst;
                return next();
            });
        },
        function addAgentsServices(_, next) {
            vasync.forEachParallel({
                inputs: newAgentServices,
                func: function addAgentSvc(agent, callback) {
                    progress('Adding service for agent \'%s\'', agent);
                    self.log.trace({
                        service: agent,
                        params: agentServices[agent]
                    }, 'Adding new agent service');
                    self.sdcadm.sapi.createService(agent, app.uuid,
                        agentServices[agent], function (err) {
                            if (err) {
                                return callback(err);
                            }
                            return callback();
                    });
                }
            }, function (err) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        }
    ]}, function (err) {
        progress('Add new agent services finished (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        if (!history) {
            self.sdcadm.log.warn('History not set for add-new-agent-svcs');
            return cb(err);
        }
        if (err) {
            history.error = err;
        }
        self.sdcadm.history.updateHistory(history, function (err2) {
            if (err) {
                return cb(err);
            } else if (err2) {
                return cb(err2);
            } else {
                return cb();
            }
        });
    });
};

ExperimentalCLI.prototype.do_add_new_agent_svcs.options = [ {
    names: ['help', 'h'],
    type: 'bool',
    help: 'Show this help.'
}];

ExperimentalCLI.prototype.do_add_new_agent_svcs.help = (
    'Temporary grabbag for installing the SDC global zone new agents.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} add-new-agent-svcs\n' +
    '\n' +
    '{{options}}'
);



/**
 * Update this SDC docker service setup:
 * - update docker0 to latest image, adding the 'docker' service to the 'sdc'
 *   app in SAPI if necessary. Limitations: Presumes only a single instance
 *   (docker0). Presumes docker0 is on the HN.
 * - hostvolume service and an instance on every CN (including the HN for now
 *   because we typically test with HN provisioning).
 * - nat service, and get latest image (instances are created)
 *
 * TODO: import other setup ideas from
 * https://gist.github.com/joshwilsdon/643e317ac0e2469d8e43
 */
ExperimentalCLI.prototype.do_update_docker =
function do_update_docker(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var start = Date.now();
    var headnode;
    var dockerSvcData = {
        name: 'docker',
        params: {
            package_name: 'sdc_768',
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
                smartdc_role: 'docker',
                smartdc_type: 'core'
            },
            customer_metadata: {}
            // TO_FILL_IN: Fill out package values using $package_name package.
        },
        metadata: {
            SERVICE_NAME: 'docker',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            USE_TLS: true,
            'user-script': 'TO_FILL_IN'
        }
    };

    var hostvolumeSvcData = {
        name: 'hostvolume',
        params: {
            package_name: 'sdc_4096',
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            networks: [
                {name: 'external', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'hostvolume',
                smartdc_type: 'core'
            },
            customer_metadata: {}
            // TO_FILL_IN: Fill out package values using $package_name package.
        },
        metadata: {
            SERVICE_NAME: 'hostvolume',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var natSvcData = {
        name: 'nat',
        params: {
            package_name: 'sdc_128',
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            networks: [
                {name: 'external', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'nat',
                smartdc_type: 'core'
            },
            customer_metadata: {}
            // TO_FILL_IN: Fill out package values using $package_name package.
        },
        metadata: {
            // Allow these keys to actually live in the zone's metadata,
            // rather than being populated by config-agent (which doesn't
            // exist in NAT zones):
            pass_vmapi_metadata_keys: [ 'com.joyent:ipnat_subnet' ],
            SERVICE_NAME: 'nat',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var context = {
        imgsToDownload: []
    };
    vasync.pipeline({arg: context, funcs: [
        /* @field ctx.dockerPkg */
        function getDockerPkg(ctx, next) {
            var filter = {name: dockerSvcData.params.package_name};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            dockerSvcData.params.package_name)}));
                }
                ctx.dockerPkg = pkgs[0];
                next();
            });
        },

        /* @field ctx.hostvolumePkg */
        function getHostvolumePkg(ctx, next) {
            var filter = {name: hostvolumeSvcData.params.package_name};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            hostvolumeSvcData.params.package_name)}));
                }
                ctx.hostvolumePkg = pkgs[0];
                next();
            });
        },

        /* @field ctx.natPkg */
        function getNatPkg(ctx, next) {
            var filter = {name: natSvcData.params.package_name};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            natSvcData.params.package_name)}));
                }
                ctx.natPkg = pkgs[0];
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

        function getSdcApp(ctx, next) {
            ctx.app = self.sdcadm.sdc;
            next();
        },

        /**
         * SDC Docker usage means biting the bullet and switching to the
         * "new" agents (cn-agent, vm-agent, net-agent) via the "no_rabbit"
         * SDC config var:
         *    https://github.com/joyent/sdc/blob/master/docs/
         *      operator-guide/configuration.md#sdc-application-configuration
         *
         * Per the warnings there, we need maint mode and config propagation.
         */
        function prepareForNoRabbits(ctx, next) {
            if (ctx.app.metadata.no_rabbit === true) {
                return next();
            }
            self.sdcadm.dcMaintStart({progress: self.progress}, next);
        },
        function ensureNoRabbitTrue(ctx, next) {
            if (ctx.app.metadata.no_rabbit === true) {
                return next();
            }
            self.progress('Setting "no_rabbit=true" SDC config');
            self.progress('Warning: This changes other behaviour in the ' +
                'whole DC to use some new agents');
            var update = {
                metadata: {
                    no_rabbit: true
                }
            };
            self.sdcadm.sapi.updateApplication(ctx.app.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },
        function waitForNoRabbits1(ctx, next) {
            if (ctx.app.metadata.no_rabbit === true) {
                return next();
            }
            self.sdcadm.dcMaintStop({progress: self.progress}, next);
        },
        function waitForNoRabbits2(ctx, next) {
            if (ctx.app.metadata.no_rabbit === true) {
                return next();
            }
            self.progress('Restarting all GZ config-agent\'s for no_rabbit ' +
                'to propagate');
            ur.execOnAllNodes({
                sdcadm: self.sdcadm,
                cmd: '/usr/sbin/svcadm disable -s config-agent && ' +
                    '/usr/sbin/svcadm enable -s config-agent'
            }, next);
        },

        function getDockerSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'docker',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.dockerSvc = svcs[0];
                }
                next();
            });
        },

        function getCloudapiSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cloudapi',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.cloudapiSvc = svcs[0];
                }
                next();
            });
        },

        function getHostvolumeSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'hostvolume',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.hostvolumeSvc = svcs[0];
                }
                next();
            });
        },

        function getNatSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'nat',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.natSvc = svcs[0];
                }
                next();
            });
        },

        /*
         * @field ctx.dockerInst
         * @field ctx.dockerVm
         */
        function getDockerInst(ctx, next) {
            if (!ctx.dockerSvc) {
                return next();
            }
            var filter = {
                service_uuid: ctx.dockerSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.dockerInst = insts[0];
                    self.sdcadm.vmapi.getVm({uuid: ctx.dockerInst.uuid},
                            function (vmErr, dockerVm) {
                        if (vmErr) {
                            return next(vmErr);
                        }
                        ctx.dockerVm = dockerVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },

        function getHostvolumeInsts(ctx, next) {
            if (!ctx.hostvolumeSvc) {
                ctx.hostvolumeInsts = [];
                return next();
            }
            var filter = {
                service_uuid: ctx.hostvolumeSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.hostvolumeInsts = insts;
                next();
            });
        },

        function getLatestDockerImage(ctx, next) {
            var filter = {name: 'docker'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.dockerImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "docker" image found'));
                }
            });
        },

        function getLatestHostvolumeImage(ctx, next) {
            var filter = {name: 'hostvolume'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.hostvolumeImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "hostvolume" image found'));
                }
            });
        },

        function getLatestNatImage(ctx, next) {
            var filter = {name: 'nat'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.natImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "nat" image found'));
                }
            });
        },

        function haveDockerImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.dockerImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.dockerImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function haveHostvolumeImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.hostvolumeImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.hostvolumeImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function haveNatImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.natImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.natImg);
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

        function createDockerSvc(ctx, next) {
            if (ctx.dockerSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = dockerSvcData.name + '.' + domain;

            self.progress('Creating "docker" service');
            dockerSvcData.params.image_uuid = ctx.dockerImg.uuid;
            dockerSvcData.metadata['user-script'] = ctx.userScript;
            dockerSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            dockerSvcData.params.cpu_shares = ctx.dockerPkg.max_physical_memory;
            dockerSvcData.params.cpu_cap = ctx.dockerPkg.cpu_cap;
            dockerSvcData.params.zfs_io_priority
                = ctx.dockerPkg.zfs_io_priority;
            dockerSvcData.params.max_lwps = ctx.dockerPkg.max_lwps;
            dockerSvcData.params.max_physical_memory =
                dockerSvcData.params.max_locked_memory =
                ctx.dockerPkg.max_physical_memory;
            dockerSvcData.params.max_swap = ctx.dockerPkg.max_swap;
            dockerSvcData.params.quota =
                (ctx.dockerPkg.quota / 1024).toFixed(0);
            dockerSvcData.params.package_version = ctx.dockerPkg.version;
            dockerSvcData.params.billing_id = ctx.dockerPkg.uuid;

            self.sdcadm.sapi.createService('docker', ctx.app.uuid,
                    dockerSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.dockerSvc = svc;
                self.log.info({svc: svc}, 'created docker svc');
                next();
            });
        },

        function createHostvolumeSvc(ctx, next) {
            if (ctx.hostvolumeSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = hostvolumeSvcData.name + '.' + domain;

            self.progress('Creating "hostvolume" service');
            hostvolumeSvcData.params.image_uuid = ctx.hostvolumeImg.uuid;
            hostvolumeSvcData.metadata['user-script'] = ctx.userScript;
            hostvolumeSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            hostvolumeSvcData.params.cpu_shares =
                ctx.hostvolumePkg.max_physical_memory;
            hostvolumeSvcData.params.cpu_cap = ctx.hostvolumePkg.cpu_cap;
            hostvolumeSvcData.params.zfs_io_priority =
                ctx.hostvolumePkg.zfs_io_priority;
            hostvolumeSvcData.params.max_lwps = ctx.hostvolumePkg.max_lwps;
            hostvolumeSvcData.params.max_physical_memory =
                hostvolumeSvcData.params.max_locked_memory =
                ctx.hostvolumePkg.max_physical_memory;
            hostvolumeSvcData.params.max_swap = ctx.hostvolumePkg.max_swap;
            hostvolumeSvcData.params.quota =
                (ctx.hostvolumePkg.quota / 1024).toFixed(0);
            hostvolumeSvcData.params.package_version =
                ctx.hostvolumePkg.version;
            hostvolumeSvcData.params.billing_id = ctx.hostvolumePkg.uuid;

            self.sdcadm.sapi.createService('hostvolume', ctx.app.uuid,
                    hostvolumeSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.hostvolumeSvc = svc;
                self.log.info({svc: svc}, 'created hostvolume svc');
                next();
            });
        },

        function createNatSvc(ctx, next) {
            if (ctx.natSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = natSvcData.name + '.' + domain;

            self.progress('Creating "nat" service');
            natSvcData.params.image_uuid = ctx.natImg.uuid;
            natSvcData.metadata['user-script'] = ctx.userScript;
            natSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            natSvcData.params.cpu_shares = ctx.natPkg.max_physical_memory;
            natSvcData.params.cpu_cap = ctx.natPkg.cpu_cap;
            natSvcData.params.zfs_io_priority = ctx.natPkg.zfs_io_priority;
            natSvcData.params.max_lwps = ctx.natPkg.max_lwps;
            natSvcData.params.max_physical_memory =
                natSvcData.params.max_locked_memory =
                ctx.natPkg.max_physical_memory;
            natSvcData.params.max_swap = ctx.natPkg.max_swap;
            natSvcData.params.quota = (ctx.natPkg.quota / 1024).toFixed(0);
            natSvcData.params.package_version = ctx.natPkg.version;
            natSvcData.params.billing_id = ctx.natPkg.uuid;

            self.sdcadm.sapi.createService('nat', ctx.app.uuid,
                    natSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.natSvc = svc;
                self.log.info({svc: svc}, 'created nat svc');
                next();
            });
        },
        function getHeadnode(_, next) {
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },
        function createDockerInst(ctx, next) {
            if (ctx.dockerInst) {
                return next();
            }
            self.progress('Creating "docker" instance');
            var instOpts = {
                params: {
                    alias: 'docker0',
                    delegate_dataset: true,
                    server_uuid: headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.dockerSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.newDockerInst = inst;
                next();
            });
        },

        /*
         * If not set, set the 'docker' key in CLOUDAPI_SERVICES
         * metadata on the cloudapi service. See "SAPI configuration" section
         * in "sdc-cloudapi.git:blob/master/docs/admin.restdown".
         */
        function updateCloudapiServicesMetadata(ctx, next) {
            var services;

            // Skip, if CLOUDAPI_SERVICES is already set.
            var existing = ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES;
            if (existing) {
                try {
                    services = JSON.parse(existing);
                } catch (ex) {
                    return next(new errors.InternalError({
                        message: format('unexpected non-JSON value for '
                            + 'cloudapi SAPI service "CLOUDAPI_SERVICES" '
                            + 'metadata: %j', existing)
                    }));
                }
                if (services.docker) {
                    return next();
                }
            }

            var dockerInst = ctx.newDockerInst || ctx.dockerInst;
            self.sdcadm.vmapi.getVm({uuid: dockerInst.uuid},
                    function (vmErr, dockerVm) {
                if (vmErr) {
                    return next(vmErr);
                }
                var dockerIp = dockerVm.nics.filter(function (nic) {
                    return nic.nic_tag === 'external';
                })[0].ip;
                var dockerUrl = format('tcp://%s:2376', dockerIp);

                try {
                    services = JSON.parse(
                        ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES || '{}');
                } catch (ex) {
                    return next(new errors.InternalError({
                        message: format('unexpected non-JSON value for '
                            + 'cloudapi SAPI service "CLOUDAPI_SERVICES" '
                            + 'metadata: %j',
                            ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES)
                    }));
                }
                self.progress('Update "docker" key in CLOUDAPI_SERVICES to',
                    dockerUrl);
                if (!services) {
                    services = {};
                }
                services.docker = dockerUrl;
                var update = {
                    metadata: {
                        CLOUDAPI_SERVICES: JSON.stringify(services)
                    }
                };
                self.sdcadm.sapi.updateService(ctx.cloudapiSvc.uuid, update,
                    errors.sdcClientErrWrap(next, 'sapi'));
            });
        },

        function getServersNeedingHostvolume(ctx, next) {
            var filter = {
                setup: true,
                reserved: false
            };
            self.sdcadm.cnapi.listServers(filter, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                // Only include running servers.
                // We *are* incuding the headnode for now because common dev
                // practice includes using the headnode for docker containers.
                var hostvolumeServers = servers.filter(
                    function (s) { return s.status === 'running'; });
                var hostvolumeInstFromServer = {};
                ctx.hostvolumeInsts.forEach(function (inst) {
                    hostvolumeInstFromServer[inst.params.server_uuid] = inst;
                });
                ctx.serversWithNoHostvolumeInst = hostvolumeServers.filter(
                        function (s) {
                    return hostvolumeInstFromServer[s.uuid] === undefined;
                });
                if (ctx.serversWithNoHostvolumeInst.length > 0) {
                    self.progress('Found %d setup, not reserved, and '
                        + 'running server(s) without a "hostvolume" instance',
                        ctx.serversWithNoHostvolumeInst.length);
                }
                next();
            });
        },

        function createHostvolumeInsts(ctx, next) {
            if (ctx.serversWithNoHostvolumeInst.length === 0) {
                return next();
            }

            self.progress('Creating "hostvolume" instances on %d server(s)',
                ctx.serversWithNoHostvolumeInst.length);
            ctx.newHostvolumeInsts = [];
            vasync.forEachPipeline({
                inputs: ctx.serversWithNoHostvolumeInst,
                func: function createHostvolumeInst(server, nextServer) {
                    var instOpts = {
                        params: {
                            alias: 'hostvolume-' + server.hostname,
                            server_uuid: server.uuid
                        }
                    };
                    self.sdcadm.sapi.createInstance(ctx.hostvolumeSvc.uuid,
                            instOpts, function (err, inst) {
                        if (err) {
                            return next(new errors.SDCClientError(err, 'sapi'));
                        }
                        self.progress('Created VM %s (%s)', inst.uuid,
                            inst.params.alias);
                        ctx.newHostvolumeInsts.push(inst);
                        nextServer();
                    });
                }
            }, next);
        },

        function updateDockerSvcImageUuid(ctx, next) {
            if (!ctx.force &&
                ctx.dockerImg.uuid === ctx.dockerSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "docker" SAPI service',
                ctx.dockerImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.dockerImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.dockerSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function updateHostvolumeSvcImageUuid(ctx, next) {
            if (!ctx.force && ctx.hostvolumeImg.uuid ===
                ctx.hostvolumeSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "hostvolume" SAPI service',
                ctx.hostvolumeImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.hostvolumeImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.hostvolumeSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function updateNatSvcImageUuid(ctx, next) {
            if (!ctx.force &&
                ctx.natImg.uuid === ctx.natSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "nat" SAPI service',
                ctx.natImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.natImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.natSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function ensureDockerDelegateDataset(ctx, next) {
            if (ctx.newDockerInst) {
                return next();
            }

            shared.ensureDelegateDataset({
                service: dockerSvcData,
                progress: self.progress,
                zonename: ctx.dockerInst.uuid,
                log: self.log,
                server: ctx.dockerVm.server_uuid
            }, next);
        },

        function reprovisionDockerInst(ctx, next) {
            if (ctx.newDockerInst) {
                return next();
            } else if (!opts.force &&
                ctx.dockerVm.image_uuid === ctx.dockerImg.uuid) {
                return next();
            }
            self.progress('Reprovisioning "docker" instance %s (%s)',
                ctx.dockerVm.uuid, ctx.dockerVm.alias);
            self.sdcadm.sapi.reprovisionInstance(ctx.dockerInst.uuid,
                    ctx.dockerImg.uuid, function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Reprovisioned "docker" instance %s (%s)',
                    ctx.dockerVm.uuid, ctx.dockerVm.alias);
                next();
            });
        },

        function reprovisionHostvolumeInsts(ctx, next) {
            vasync.forEachPipeline({
                inputs: ctx.hostvolumeInsts,
                func: function reprovHostvolumeInst(inst, nextInst) {
                    // First get its current image from VMAPI to not reprov
                    // if not necessary.
                    self.sdcadm.vmapi.getVm({uuid: inst.uuid},
                            function (vmErr, vm) {
                        if (vmErr) {
                            return nextInst(vmErr);
                        } else if (vm.image_uuid === ctx.hostvolumeImg.uuid) {
                            return nextInst();
                        }
                        self.progress('Reprovisioning %s (%s) inst to image %s',
                            inst.uuid, inst.params.alias,
                            ctx.hostvolumeImg.uuid);
                        self.sdcadm.sapi.reprovisionInstance(
                                inst.uuid,
                                ctx.hostvolumeImg.uuid, function (err) {
                            if (err) {
                                return nextInst(
                                    new errors.SDCClientError(err, 'sapi'));
                            }
                            self.progress('Reprovisioned %s (%s) inst to '
                                + 'image %s', inst.uuid, inst.params.alias,
                                ctx.hostvolumeImg.uuid);
                            nextInst();
                        });
                    });
                }
            }, next);
        },

        function done(_, next) {
            self.progress('Updated SDC Docker (%ds)',
                Math.floor((Date.now() - start) / 1000));
            next();
        }
    ]}, cb);
};

ExperimentalCLI.prototype.do_update_docker.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Allow update to proceed even if already at latest image.'
    }
];
ExperimentalCLI.prototype.do_update_docker.help = (
    'Add/update the docker service.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-docker\n' +
    '\n' +
    '{{options}}'
);



/**
 * Installs a custom TLS certificate for the sdc-docker service. By default
 * sdc-docker uses a self-signed certificate that gets created when the zone
 * is created for the first time. This command allows installing a custom
 * certificate to be used by sdc-docker.
 */
ExperimentalCLI.prototype.do_install_docker_cert =
function do_install_docker_cert(subcmd, opts, args, cb) {
    var self = this;
    var dockerVm;

    if (!opts.key) {
        return cb(new errors.UsageError(
            'must specify certificate key path (-k or --key)'));
    }
    if (!opts.cert) {
        return cb(new errors.UsageError(
            'must specify certificate path (-c or --cert)'));
    }

    vasync.pipeline({funcs: [
        function ensureDockerInstance(_, next) {
            var filters = {
                state: 'active',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid,
                'tag.smartdc_role': 'docker'
            };
            self.sdcadm.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                if (Array.isArray(vms) && !vms.length) {
                    return next(new errors.UpdateError('no "docker" VM ' +
                        'instance found'));
                }
                dockerVm = vms[0];
                return next();
            });
        },

        function installKey(_, next) {
            self.progress('Installing certificate');
            var argv = [
                'cp',
                opts.key,
                '/zones/' + dockerVm.uuid + '/root/data/tls/key.pem'
            ];

            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                self.log.trace({cmd: argv.join(' '), err: err, stdout: stdout,
                    stderr: stderr}, 'ran cp command');
                if (err) {
                    return next(new errors.InternalError({
                        message: 'error installing certificate key',
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        },

        function installCertificate(_, next) {
            var argv = [
                'cp',
                opts.cert,
                '/zones/' + dockerVm.uuid + '/root/data/tls/cert.pem'
            ];

            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                self.log.trace({cmd: argv.join(' '), err: err, stdout: stdout,
                    stderr: stderr}, 'ran cp command');
                if (err) {
                    return next(new errors.InternalError({
                        message: 'error installing certificate',
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        },

        function restartSdcDockerSvc(_, next) {
            self.progress('Restarting sdc-docker service');

            svcadm.svcadmRestart({
                fmri: 'docker',
                zone: dockerVm.uuid,
                log: self.log
            }, next);
        }
    ]}, cb);
};

ExperimentalCLI.prototype.do_install_docker_cert.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['cert', 'c'],
        type: 'string',
        help: 'Path to certificate.'
    },
    {
        names: ['key', 'k'],
        type: 'string',
        help: 'Path to private key.'
    }
];
ExperimentalCLI.prototype.do_install_docker_cert.help = (
    'Installs a custom TLS certificate to be used by sdc-docker.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} install-docker-cert\n' +
    '\n' +
    '{{options}}'
);

/**
 * Update portolan0, adding the 'portolan' service to the 'sdc' app in SAPI
 * if necessary.
 *
 * Limitations:
 * - presumes only a single instance (portolan0)
 * - presumes portolan0 is on the HN
 */
ExperimentalCLI.prototype.do_portolan =
function portolan(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var svcData = {
        name: 'portolan',
        params: {
            package_name: 'sdc_768',
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            networks: ['admin'],
            firewall_enabled: true,
            tags: {
                smartdc_role: 'portolan',
                smartdc_type: 'core'
            },
            customer_metadata: {}
            // TO_FILL_IN: Fill out package values using sdc_768 package.
        },
        metadata: {
            SERVICE_NAME: 'portolan',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var img, haveImg, app, svc, inst, svcExists, instExists, imgNoop, headnode;

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.package */
        function getPackage(ctx, next) {
            var filter = {name: 'sdc_768'};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: pkgs.length + ' "sdc_768" packages found'
                    }));
                }
                ctx.package = pkgs[0];
                next();
            });
        },
        function getSdcApp(_, next) {
            app = self.sdcadm.sdc;
            next();
        },

        function getPortolanSvc(_, next) {
            self.sdcadm.sapi.listServices({
                name: 'portolan',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    svc = svcs[0];
                    svcExists = true;
                } else {
                    svcExists = false;
                }
                next();
            });
        },

        function getPortolanInst(_, next) {
            if (!svcExists) {
                instExists = false;
                return next();
            }
            var filter = {
                service_uuid: svc.uuid,
                name: 'portolan'
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    inst = insts[0];
                    instExists = true;
                } else {
                    instExists = false;
                }
                next();
            });
        },

        function getLatestImage(_, next) {
            var filter = {name: 'portolan'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    img = images[images.length - 1]; //XXX presuming sorted
                } else {
                    next(new errors.UpdateError('no "portolan" image found'));
                }

                if (!opts.force && svcExists &&
                        img.uuid === svc.params.image_uuid) {
                    imgNoop = true;
                    self.progress('Portolan image %s (%s %s) matches the ' +
                        'service: nothing to do', img.uuid, img.name,
                        img.version);
                } else {
                    imgNoop = false;
                }
                next();
            });
        },

        function haveImageAlready(_, next) {
            self.sdcadm.imgapi.getImage(img.uuid, function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    haveImg = false;
                } else if (err) {
                    next(err);
                } else {
                    haveImg = true;
                }
                next();
            });
        },

        function importImage(_, next) {
            if (imgNoop || haveImg) {
                return next();
            }
            var proc = new DownloadImages({images: [img]});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userScript */
        shared.getUserScript,

        function createPortolanSvc(ctx, next) {
            if (imgNoop || svcExists) {
                return next();
            }

            var domain = app.metadata.datacenter_name + '.' +
                    app.metadata.dns_domain;
            var svcDomain = svcData.name + '.' + domain;

            self.progress('Creating "portolan" service');
            svcData.params.image_uuid = img.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            svcData.params.cpu_shares = ctx.package.max_physical_memory;
            svcData.params.cpu_cap = ctx.package.cpu_cap;
            svcData.params.zfs_io_priority = ctx.package.zfs_io_priority;
            svcData.params.max_lwps = ctx.package.max_lwps;
            svcData.params.max_physical_memory =
                ctx.package.max_physical_memory;
            svcData.params.max_locked_memory = ctx.package.max_physical_memory;
            svcData.params.max_swap = ctx.package.max_swap;
            svcData.params.quota = (ctx.package.quota / 1024).toFixed(0);
            svcData.params.package_version = ctx.package.version;
            svcData.params.billing_id = ctx.package.uuid;

            self.sdcadm.sapi.createService('portolan', app.uuid, svcData,
                    function (err, svc_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                svc = svc_;
                self.log.info({svc: svc}, 'created portolan svc');
                next();
            });
        },
        function getHeadnode(_, next) {
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },
        function createPortolanInst(_, next) {
            if (imgNoop || instExists) {
                return next();
            }
            self.progress('Creating "portolan" instance');
            var instOpts = {
                params: {
                    alias: 'portolan0',
                    server_uuid: headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(svc.uuid, instOpts,
                    function (err, inst_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                inst = inst_;
                next();
            });
        },

        function reprovisionPortolanInst(_, next) {
            if (imgNoop || !instExists) {
                return next();
            }
            self.progress('Reprovision "portolan" instance %s (%s)',
                inst.uuid, inst.alias);
            self.sdcadm.sapi.reprovisionInstance(inst.uuid, img.uuid,
                    function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                next();
            });
        },

        function done(_, next) {
            if (imgNoop) {
                return next();
            }
            self.progress('Updated portolan');
            next();
        }
    ]}, cb);
};

ExperimentalCLI.prototype.do_portolan.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Allow updates to proceed even if already at latest image.'
    }
];

ExperimentalCLI.prototype.do_portolan.help = (
    'Add/update the portolan service.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} portolan\n' +
    '\n' +
    '{{options}}'
);


ExperimentalCLI.prototype.do_fabrics = fabrics.do_fabrics;
ExperimentalCLI.prototype.do_default_fabric = defFabric.do_default_fabric;



//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
