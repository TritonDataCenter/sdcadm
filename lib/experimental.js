/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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

    if (!opts.latest && !args[0]) {
        return cb(new errors.UsageError(
            'must specify installer image UUID or --latest'));
    }

    return self.sdcadm.updateAgents({
        image: (opts.latest) ? 'latest' : args[0],
        progress: self.progress,
        justDownload: opts.just_download
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
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published agents installer.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the agents installer for later usage.'
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
    cb();
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
            self.sdcadm.sapi.listApplications({ name: 'sdc' },
            function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }

                app = apps[0];
                domain = app.metadata.datacenter_name + '.' +
                    app.metadata.dns_domain;
                sapiUrl = app.metadata['sapi-url'];

                return next();
            });
        },

        function getServices(_, next) {
            self.sdcadm.getServices({}, function (err, svcs) {
                if (err) {
                    return next(err);
                }

                services = svcs;
                // Locate CA for later
                svcs.forEach(function (svc) {
                    if (svc.name === 'ca') {
                        caSvc = svc;
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
        }
    ]}, function (err) {
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

    var app, svc, inst, vm, img;
    var agentNames = ['vm-agent', 'net-agent', 'cn-agent'];
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
        function getSdcApp(_, next) {
            progress('Getting SDC application details from SAPI');
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


/*
 * Update platform in datancenter with a given or latest agents installer.
 */
ExperimentalCLI.prototype.do_install_platform =
function do_install_platform(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (opts.latest) {
        self.sdcadm._installPlatform({
            image: 'latest',
            progress: self.progress
        }, cb);
    } else if (args[0]) {
        self.sdcadm._installPlatform({
            image: args[0],
            progress: self.progress
        }, cb);
    } else {
        cb(new errors.UsageError(
            'must specify platform image UUID or --latest'));
    }
};
ExperimentalCLI.prototype.do_install_platform.help = (
    'Download and install platform image for later assignment.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} install-platform IMAGE-UUID\n' +
    '     {{name}} install-platform PATH-TO-IMAGE\n' +
    '     {{name}} install-platform --latest\n' +
    '\n' +
    '{{options}}'
);
ExperimentalCLI.prototype.do_install_platform.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published platform image.'
    }
];



/*
 * Assign a platform image to a particular headnode or computenode.
 */
ExperimentalCLI.prototype.do_assign_platform =
function do_assign_platform(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var platform = args[0];
    var server = args[1];
    var assignOpts;

    if (opts.all && server) {
        return cb(new errors.UsageError(
            'using --all and explicitly specifying ' +
            'a server are mutually exclusive'));
    } else if (opts.all) {
        assignOpts = {
            all: true,
            platform: platform,
            progress: self.progress
        };
    } else if (platform && server) {
        assignOpts = {
            server: server,
            platform: platform,
            progress: self.progress
        };
    } else {
        return cb(new errors.UsageError(
            'must specify platform and server (or --all)'));
    }
    self.sdcadm._assignPlatform(assignOpts, cb);
};
ExperimentalCLI.prototype.do_assign_platform.help = (
    'Assign platform image to SDC servers.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} assign-platform PLATFORM SERVER\n' +
    '     {{name}} assign-platform PLATFORM --all\n' +
    '\n' +
    '{{options}}'
);
ExperimentalCLI.prototype.do_assign_platform.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['all'],
        type: 'bool',
        help: 'Assign given platform image to all servers instead of just one.'
    }
];



/**
 * Update docker0, adding the 'docker' service to the 'sdc' app in SAPI
 * if necessary.
 *
 * Limitations:
 * - presumes only a single instance (docker0)
 * - presumes docker0 is on the HN
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

    var dockerSvcData = {
        name: 'docker',
        params: {
            package_name: 'sdc_768',
            image_uuid: 'TO_FILL_IN',
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
            // TO_FILL_IN: Fill out package values using sdc_768 package.
        },
        metadata: {
            SERVICE_NAME: 'docker',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.package */
        function getPackage(ctx, next) {
            var filter = {name: 'sdc_768'};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: pkgs.length + ' "sdc_768" packages found'}));
                }
                ctx.package = pkgs[0];
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
            self.sdcadm.sapi.listApplications({name: 'sdc'},
            function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps.length) {
                    return next(new errors.SDCClientError(new Error(
                        'No applications named "sdc"'), 'sapi'));
                }
                ctx.app = apps[0];
                next();
            });
        },

        function ensureNoRabbitTrue(ctx, next) {
            if (ctx.app.metadata.no_rabbit === true) {
                return next();
            }
            self.progress('Setting "no_rabbit=true" SDC config');
            self.progress('Warning: This changes other behaviour in the '
                + 'whole DC to use some new agents');
            var update = {
                metadata: {
                    no_rabbit: true
                }
            };
            self.sdcadm.sapi.updateApplication(ctx.app.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function getDockerSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'docker',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.svc = svcs[0];
                }
                next();
            });
        },

        function getDockerInst(ctx, next) {
            if (!ctx.svc) {
                return next();
            }
            var filter = {
                service_uuid: ctx.svc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.inst = insts[0];
                }
                next();
            });
        },

        function getLatestImage(ctx, next) {
            var filter = {name: 'docker'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    ctx.img = images[images.length - 1]; //XXX presuming sorted
                } else {
                    next(new errors.UpdateError('no "docker" image found'));
                }

                if (!opts.force && ctx.svc &&
                        ctx.img.uuid === ctx.svc.params.image_uuid) {
                    ctx.imgNoop = true;
                    self.progress('Latest Docker image %s (%s %s) matches ' +
                        'the service (no image update)', ctx.img.uuid,
                        ctx.img.name, ctx.img.version);
                } else {
                    ctx.imgNoop = false;
                }
                next();
            });
        },

        function haveImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.img.uuid, function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.haveImg = false;
                } else if (err) {
                    next(err);
                } else {
                    ctx.haveImg = true;
                }
                next();
            });
        },

        function importImage(ctx, next) {
            if (ctx.imgNoop || ctx.haveImg) {
                return next();
            }
            var proc = new DownloadImages({images: [ctx.img]});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userString */
        shared.getUserScript,

        function createDockerSvc(ctx, next) {
            if (ctx.imgNoop || ctx.svc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = dockerSvcData.name + '.' + domain;

            self.progress('Creating "docker" service');
            dockerSvcData.params.image_uuid = ctx.img.uuid;
            dockerSvcData.metadata['user-script'] = ctx.userScript;
            dockerSvcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            dockerSvcData.params.cpu_shares = ctx.package.max_physical_memory;
            dockerSvcData.params.cpu_cap = ctx.package.cpu_cap;
            dockerSvcData.params.zfs_io_priority = ctx.package.zfs_io_priority;
            dockerSvcData.params.max_lwps = ctx.package.max_lwps;
            dockerSvcData.params.max_physical_memory =
                ctx.package.max_physical_memory;
            dockerSvcData.params.max_locked_memory =
                ctx.package.max_physical_memory;
            dockerSvcData.params.max_swap = ctx.package.max_swap;
            dockerSvcData.params.quota = (ctx.package.quota / 1024).toFixed(0);
            dockerSvcData.params.package_version = ctx.package.version;
            dockerSvcData.params.billing_id = ctx.package.uuid;

            self.sdcadm.sapi.createService('docker', ctx.app.uuid,
                    dockerSvcData, function (err, svc_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                svc = svc_;
                self.log.info({svc: svc}, 'created docker svc');
                next();
            });
        },

        function createDockerInst(ctx, next) {
            if (ctx.inst) {
                return next();
            }
            self.progress('Creating "docker" instance');
            var instOpts = {
                params: {
                    alias: 'docker0'
                }
            };
            self.sdcadm.sapi.createInstance(ctx.svc.uuid, instOpts,
                    function (err, inst_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.inst = inst_;
                next();
            });
        },

        function updateSvcImageUuid(ctx, next) {
            if (ctx.imgNoop || !ctx.inst) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "docker" SAPI service',
                ctx.img.uuid);
            var update = {
                params: {
                    image_uuid: ctx.img.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.svc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function reprovisionDockerInst(ctx, next) {
            if (ctx.imgNoop || !ctx.inst) {
                return next();
            }
            self.progress('Reprovision "docker" instance %s', ctx.inst.uuid);
            self.sdcadm.sapi.reprovisionInstance(ctx.inst.uuid, ctx.img.uuid,
                    function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                next();
            });
        },

        function done(_, next) {
            self.progress('Updated SDC Docker');
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

    var img, haveImg, app, svc, inst, svcExists, instExists, imgNoop;

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.package */
        function getPackage(ctx, next) {
            var filter = {name: 'sdc_768'};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: pkgs.length + ' "sdc_768" packages found'}));
                }
                ctx.package = pkgs[0];
                next();
            });
        },
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
                next();
            });
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

        function createPortolanInst(_, next) {
            if (imgNoop || instExists) {
                return next();
            }
            self.progress('Creating "portolan" instance');
            var instOpts = {
                params: {
                    alias: 'portolan0'
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

//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
