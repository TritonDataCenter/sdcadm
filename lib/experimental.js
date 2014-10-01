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



//---- globals



//---- Experimental CLI class

function ExperimentalCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm experimental',
        desc: 'Experimental, unsupported, temporary sdcadm commands.\n'
            + '\n'
            + 'These are unsupported and temporary commands to assist with\n'
            + 'migration away from incr-upgrade scripts. The eventual\n'
            + 'general upgrade process will not include any commands under\n'
            + '"sdcadm experimental".',
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

    if (opts.latest) {
        self.sdcadm.updateAgents(
            { image: 'latest', progress: self.progress }, cb);
    } else if (args[0]) {
        self.sdcadm.updateAgents(
            { image: args[0], progress: self.progress }, cb);
    } else {
        cb(new errors.UsageError(
            'must specify installer image UUID or --latest'));
    }
};
ExperimentalCLI.prototype.do_update_agents.help = (
    'Update SDC agents\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} update-agents IMAGE-UUID\n'
    + '     {{name}} update-agents PATH-TO-INSTALLER\n'
    + '     {{name}} update-agents --latest\n'
    + '\n'
    + '{{options}}'
);
ExperimentalCLI.prototype.do_update_agents.options = [
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published agents installer.'
    }
];

//ExperimentalCLI.prototype.do_foo = function do_foo(subcmd, opts, args, cb) {
//    p('experimental foo')
//    cb();
//};
//ExperimentalCLI.prototype.do_foo.help = (
//    'foo\n'
//    + '\n'
//    + 'Usage:\n'
//    + '     {{name}} foo [<options>]\n'
//    + '\n'
//    + '{{options}}'
//);


ExperimentalCLI.prototype.do_dc_maint = function do_dc_maint(
        subcmd, opts, args, cb) {
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
    'Show and modify the DC maintenance mode.\n'
    + '\n'
    + '"Maintenance mode for an SDC means that Cloud API is in read-only\n'
    + 'mode. Modifying requests will return "503 Service Unavailable".\n'
    + 'Workflow API will be drained on entering maint mode.\n'
    + '\n'
    + 'Limitation: This does not current wait for config changes to be made\n'
    + 'and cloudapi instances restarted. That means there is a window after\n'
    + 'starting that new jobs could come in.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} dc-maint [-j]           # show DC maint status\n'
    + '     {{name}} dc-maint [--start]      # start DC maint\n'
    + '     {{name}} dc-maint [--stop]       # stop DC maint\n'
    + '\n'
    + '{{options}}'
);


/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-other.sh".
 */
ExperimentalCLI.prototype.do_update_other = function do_update_other(
        subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var app, caInst, caSvc, domain, regionName, sapiUrl, services;

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
        getSdcApp,
        getServices,
        updateMaintainResolvers,
        updateServiceDomains,
        updateAppDomains,
        updateCaParams,
        updateRegionName,
        addSapiDomainToNodeConfig
    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        progress('Done.');
        return cb();
    });

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
    }

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
    }

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
    }

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
    }

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
    }

    // updateCaParams functions begin

    function getCaInstance(_, next) {
        var filters = {
            state: 'active',
            owner_uuid: self.sdcadm.config.ufds_admin_uuid,
            alias: 'ca0'
        };

        self.sdcadm.vmapi.listVms(filters, function (vmsErr, vms) {
            if (vmsErr) {
                return next(vmsErr);
            }

            caInst = vms[0];
            return next();
        });
    }

    function updateCaService(_, next) {
        if (caSvc.params.max_physical_memory >= 4096) {
            return next();
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

        updateService(caSvc.uuid, { params: params }, next);
    }

    function updateCaInstance(_, next) {
        if (caInst.max_physical_memory >= 4096) {
            return next();
        }

        progress('Updating CA\'s ca0 instance max_physical_memory value');
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
        common.execFilePlus({argv: argv, log: self.log}, next);
    }

    // updateCaParams functions end

    function updateCaParams(_, next) {
        vasync.pipeline({
            funcs: [getCaInstance, updateCaService, updateCaInstance]
        }, next);
    }

    // updateRegionName functions begin

    function readRegionName(_, next) {
        progress('Updating region_name for this data center');

        var field = {
            name: 'region_name',
            hidden: false,
            confirm: true
        };
        readField(field, function (err, value) {
            if (err) {
                return next(err);
            }

            regionName = value;
            return next();
        });
    }

    function appendRegionName(_, next) {
        var region = 'region_name=' + regionName + '\n';
        fs.appendFile('/mnt/usbkey/config', region, function (err) {
            if (err) {
                return next(err);
            }

            var argv = [
                '/usr/bin/cp',
                '/mnt/usbkey/config',
                '/usbkey/config'
            ];
            common.execFilePlus({argv: argv, log: self.log}, next);
        });
    }

    function updateSapiRegionName(_, next) {
        var metadata = { region_name: regionName };
        updateApplication({ metadata: metadata }, next);
    }

    // updateRegionName functions end

    function updateRegionName(_, next) {
        fs.readFile('/usbkey/config', {encoding: 'utf8'}, function (err, data) {
            if (err) {
                return next(err);
            /* JSSTYLED */
            } else if (data.search(/region_name=/) !== -1) {
                progress('No need to update region_name for this data center');
                return next();
            }

            vasync.pipeline({funcs: [
                readRegionName,
                mountUsbKey,
                appendRegionName,
                unmountUsbKey,
                updateSapiRegionName
            ]}, next);
        });
    }

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
};
ExperimentalCLI.prototype.do_update_other.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
ExperimentalCLI.prototype.do_update_other.help = (
    'Temporary grabbag for small SDC update steps.\n'
    + 'The eventual goal is to integrate all of this into "sdcadm update".\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} update-other\n'
    + '\n'
    + '{{options}}'
);


/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-tools.sh".
 */
ExperimentalCLI.prototype.do_update_gz_tools = function do_update_gz_tools(
        subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var execStart = Date.now();

    if (opts.latest) {
        self.sdcadm.updateGzTools({ image: 'latest', progress: progress },
            finish);
    } else if (args[0]) {
        self.sdcadm.updateGzTools({ image: args[0], progress: progress },
            finish);
    } else {
        finish(new errors.UsageError(
            'must specify installer image UUID or --latest'));
    }

    function finish(err) {
        if (err) {
            return cb(err);
        }
        progress('Updated gz-tools successfully (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        cb();
    }
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
    }
];
ExperimentalCLI.prototype.do_update_gz_tools.help = (
    'Temporary grabbag for updating the SDC global zone tools.\n'
    + 'The eventual goal is to integrate all of this into "sdcadm update".\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} update-gz-tools IMAGE-UUID\n'
    + '     {{name}} update-gz-tools PATH-TO-INSTALLER\n'
    + '     {{name}} update-gz-tools --latest\n'
    + '\n'
    + '{{options}}'
);


ExperimentalCLI.prototype.do_add_2nd_manatee =
function do_create_2nd_manatee(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (!opts.server) {
        return cb(new errors.UsageError('Target server uuid must be' +
                    'specified'));
    }


    function waitForDisabled(server, zuuid, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForDisabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                format('-n %s', server),
                format('/usr/sbin/zlogin %s ', zuuid) +
                format('\'json %s < ' +
                        '/opt/smartdc/manatee/etc/sitter.json\'', flag)
            ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    callback(err);
                } else {
                    var res = JSON.parse(stdout.trim());
                    counter += 1;
                    if (res[0].result.stdout.trim() === 'false') {
                        callback();
                    } else {
                        if (counter < limit) {
                            return setTimeout(_waitForDisabled, 5000);
                        } else {
                            return callback(format(
                                'Timeout (60s) waiting for config flag' +
                                ' %s to be disabled', flag));
                        }

                    }
                }
            });
        }
        _waitForDisabled();
    }



    function getShardStatus(manateeUUID, callback) {
        var argv = [
            '/usr/sbin/zlogin',
            manateeUUID,
            'source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm status'
        ];

        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            // REVIEW: Shall we try/catch here?
            var manateeShard = JSON.parse(stdout);
            return callback(null, manateeShard);
        });
    }


    function waitForHA(localManateeUUID, callback) {
        var counter = 0;
        var limit = 60;
        function _waitForHA() {
            getShardStatus(localManateeUUID, function (err, o) {
                if (err) {
                    return callback(err);
                }
                if (o.sdc.primary && o.sdc.sync &&
                    o.sdc.primary.repl.sync_state === 'sync') {
                    return callback();
                } else {
                    if (counter < limit) {
                        return setTimeout(_waitForHA, 5000);
                    } else {
                        return callback('Timeout (5m) waiting for HA');
                    }
                }
            });
        }
        _waitForHA();
    }


    function waitForPostgresUp(server, zone, callback) {
        var counter = 0;
        var limit = 36;
        function _waitForPostgresUp() {
            var arg = [
                format('-n %s ', server),
                format('/usr/sbin/zlogin %s ', zone) +
                '\'/opt/local/bin/psql -U postgres -t -A -c ' +
                '"SELECT NOW() AS when;"\''
            ];

            var child = spawn('/opt/smartdc/bin/sdc-oneachnode', arg);
            var stdout = [];
            var stderr = [];
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function (so) {
                stdout.push(so);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function (se) {
                stderr.push(se);
            });

            child.on('close', function vmadmDone(code, signal) {
                stdout = stdout.join('');
                stderr = stderr.join('');
                self.log.debug({
                    code: code,
                    signal: signal,
                    stdout: stdout,
                    stderr: stderr
                }, 'Ping PostgreSQL');
                if ((code || signal)) {
                    if (counter < limit) {
                        return setTimeout(_waitForPostgresUp, 5000);
                    } else {
                        return callback('Timeout (60s) waiting for Postgres');
                    }
                } else {
                    return callback();
                }
            });
        }
        _waitForPostgresUp();
    }


    function restartSitter(server, zone, callback) {
        self.log.trace({
            server: server,
            zone: zone
        }, 'Restarting manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('/usr/sbin/svcadm -z %s restart manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });
    }


    function enableSitter(server, zone, callback) {
        self.log.trace({
            server: server,
            zone: zone
        }, 'Restarting manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('/usr/sbin/svcadm -z %s enable -s manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: self.log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });

    }

    var app, svc, inst, vm;
    var newId;

    vasync.pipeline({funcs: [
        function checkTargetServer(_, next) {
            self.progress('Verifying target sever "%s" exists', opts.server);
            self.sdcadm.cnapi.getServer(opts.server, function (sErr, serv) {
                if (sErr) {
                    return next(sErr);
                }
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

        function getManateeServices(_, next) {
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
                        'No services named "manatee"'), 'sapi'));
                }
                svc = svcs[0];
                return next();
            });
        },

        function getManateeInstances(_, next) {
            self.progress('Getting SDC\'s manatee instances from SAPI');
            self.sdcadm.sapi.listInstances({
                service_uuid: svc.uuid
            }, function (instErr, insts) {
                if (instErr) {
                    return next(instErr);
                }

                if (!insts.length) {
                    return next(new errors.SDCClientError(new Error(
                        'Unable to find first manatee instance'), 'sapi'));
                }

                if (insts.length > 1) {
                    return next(new errors.SDCClientError(new Error(format(
                        'You already have %s manatee instances.\n',
                        insts.length) + 'add-2nd-manatee only has sense' +
                        'when you have a singel manatee instance'), 'sapi'));
                }

                inst = insts[0];
                return next();
            });
        },

        function getPrimaryManateeVm(_, next) {
            self.progress('Getting primary manatee details from VMAPI');
            self.sdcadm.vmapi.getVm({uuid: inst.uuid}, function (vmErr, obj) {
                if (vmErr) {
                    return next(vmErr);
                }
                vm = obj;
                return next();
            });
        },

        function create2ndManatee(_, next) {
            self.progress('Creating 2nd manatee through SAPI');
            self.sdcadm.sapi.createInstance(svc.uuid, {
                params: {
                    alias: 'manatee1',
                    server_uuid: opts.server,
                    owner_uuid: self.sdcadm.config.ufds_admin_uuid
                },
                metadata: {
                    DISABLE_SITTER: true
                }
            }, function (createErr, body) {
                if (createErr) {
                    return next(createErr);
                }
                newId = body.uuid;
                return next();
            });
        },

        function waitForInstToBeUp(_, next) {
            self.progress('Waiting 15 seconds for the new manatee1 vm' +
                        ' (%s) to come up', newId);
            // This is the same lame thing than for incr-upgrades
            // TODO: improve this to use instance "up" checks from TOOLS-551
            setTimeout(next, 15 * 1000);
        },

        function disableONWM(_, next) {
            self.progress('Disabling ONE_NODE_WRITE_MODE on manatee0 (SAPI)');
            self.sdcadm.sapi.updateInstance(vm.uuid, {
                action: 'delete',
                metadata: {
                    ONE_NODE_WRITE_MODE: true
                }
            }, function (err) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        },

        function removeSitterDisabled(_, next) {
            self.progress('Removing DISABLE_SITTER on manatee1 (SAPI)');
            self.sdcadm.sapi.updateInstance(newId, {
                action: 'delete',
                metadata: {
                    DISABLE_SITTER: true
                }
            }, function (err) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        },

        function wait4ONWMDisabled(_, next) {
            self.progress('Waiting for ONE_NODE_WRITE_MODE to be disabled');
            waitForDisabled(vm.server_uuid, vm.uuid,
                    'postgresMgrCfg.oneNodeWriteMode', next);
        },

        function wait4SitterEnabled(_, next) {
            self.progress('Waiting for DISABLE_SITTER to be removed');
            waitForDisabled(opts.server, newId, 'disableSitter', next);
        },

        function restartPrimarySitter(_, next) {
            self.progress('Restarting SITTER on manatee0');
            restartSitter(vm.server_uuid, vm.uuid, next);
        },

        function waitForPostgres(_, next) {
            self.progress('Waiting for PostgreSQL to come up on manatee0');
            waitForPostgresUp(vm.server_uuid, vm.uuid, next);
        },

        function enableNewSitter(_, next) {
            self.progress('Restarting SITTER on manatee1');
            enableSitter(opts.server, newId, next);
        },

        function waitForManateeHA(_, next) {
            self.progress('Finally, waiting for manatee to reach HA');
            waitForHA(vm.uuid, next);
        }

    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        self.progress('Done.');
        return cb();
    });
};

ExperimentalCLI.prototype.do_add_2nd_manatee.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['server'],
        type: 'string',
        help: 'The uuid for the target server.'
    }
];
ExperimentalCLI.prototype.do_add_2nd_manatee.help = (
    'Create a second manatee instance as the 1st required step for HA.\n' +
    '\n' +
    'When you have one manatee initially, you\'re in ONE_NODE_WRITE_MODE\n' +
    'which is a special mode that exists just for bootstrapping. To go\n' +
    'from this mode to a HA setup you\'ll need at least one more manatee.\n' +
    'Switching modes however is not quite as simple as just provisioning a\n' +
    'second one. This script attempts to move you from one instance to a HA\n' +
    'setup.\n' +
    '\n' +
    'After examining your setup and ensuring you\'re in the correct state\n' +
    'it will:\n' +
    '\n' +
    '- create a second manatee instance for you (with manatee-sitter' +
    'disabled)\n' +
    '- disable the one_node_write mode on the first instance\n' +
    '- reboot the first manatee into mulit-node mode\n' +
    '- reenable the sitter and reboot the second instance\n' +
    '- wait for manatee to return that it\'s synchronized\n' +
    '\n' +
    'After you\'ve gone through this, you\'ll be able to create a 3rd\n' +
    'manatee without using this tool.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} add-2nd-manatee\n' +
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

    var agentServices = {
        'vm-agent': {
            type: 'agent',
            params: {
                tags: {
                    smartdc_role: 'vm-agent',
                    smartdc_type: 'core'
                }
            },
            metadata: {
                SERVICE_NAME: 'vm-agent',
                VM_AGENT_LOG_LEVEL: 'info'
            },
            manifests: {
            }
        },
        'net-agent': {
            type: 'agent',
            params: {
                tags: {
                    smartdc_role: 'net-agent',
                    smartdc_type: 'core'
                }
            },
            metadata: {
                SERVICE_NAME: 'net-agent',
                NET_AGENT_LOG_LEVEL: 'info'
            },
            manifests: {
            }
        }
    };
    var newAgentServices = [];

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
                    'does not have the minimum SAPI version needed for adding '+
                    'service agents. Please, try again after upgrading SAPI')));
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
        if (err) {
            return cb(err);
        }
        progress('New agent services added successfully (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        return cb();
    });
};

ExperimentalCLI.prototype.do_add_new_agent_svcs.options = [
{
    names: ['help', 'h'],
    type: 'bool',
    help: 'Show this help.'
}];

ExperimentalCLI.prototype.do_add_new_agent_svcs.help = (
    'Temporary grabbag for installing the SDC global zone new agents.\n'
    + 'The eventual goal is to integrate all of this into "sdcadm update".\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} add-new-agent-svcs\n'
    + '\n'
    + '{{options}}'
);

//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
