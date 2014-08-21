/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
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
            minHelpCol: 23 /* line up with option help */
        }
    });
}
util.inherits(ExperimentalCLI, Cmdln);

ExperimentalCLI.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.logCb = this.top.logCb;
    Cmdln.prototype.init.apply(this, arguments);
};


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
        this.sdcadm.dcMaintStart({logCb: self.logCb}, cb);
    } else if (opts.stop) {
        this.sdcadm.dcMaintStop({logCb: self.logCb}, cb);
    } else {
        this.sdcadm.dcMaintStatus(function (err, status) {
            if (err) {
                return cb(err);
            }
            if (opts.json) {
                self.logCb(JSON.stringify(status, null, 4));
            } else if (status.maint) {
                if (status.startTime) {
                    self.logCb(format('DC maintenance: on (since %s)',
                        status.startTime));
                } else {
                    self.logCb('DC maintenance: on');
                }
            } else {
                self.logCb('DC maintenance: off');
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


ExperimentalCLI.prototype.do_update_other = function do_update_other(
        subcmd, opts, args, cb) {
    var self = this;
    var logCb = self.logCb;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var app, caInst, caSvc, domain, regionName, sapiUrl, services;

    // Helper functions

    function updateService(uuid, opts, next) {
        self.sdcadm.sapi.updateService(uuid, opts, function (err, svc) {
            if (err) {
                return next(new errors.SDCClientError(err, 'sapi'));
            }
            next();
        });
    }

    function updateApplication(opts, next) {
        self.sdcadm.sapi.updateApplication(app.uuid, opts, function (err, svc) {
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

        logCb('Done.');
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
        logCb('Updating maintain_resolvers for all vm services');

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
        logCb(format('Updating DNS domain service metadata for %s',
            SERVICES.join(', ')));

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
        logCb(format('Updating DNS domain SDC application metadata for %s',
            SERVICES.join(', ')));

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

        logCb('Updating CA service\'s max_physical_memory value');

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

        logCb('Updating CA\'s ca0 instance max_physical_memory value');

        var VMADM = '/usr/sbin/vmadm';
        var args = [
            'update',
            caInst.uuid,
            'max_physical_memory=4096',
            'max_locked_memory=4096',
            'max_swap=8192',
            'zfs_io_priority=20',
            'cpu_cap=400'
        ];

        execFile(VMADM, args, function (err, stdout, stderr) {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return next(err);
            }

            return next();
        });
    }

    // updateCaParams functions end

    function updateCaParams(_, next) {
        vasync.pipeline({
            funcs: [ getCaInstance, updateCaService, updateCaInstance]
        }, next);
    }

    // updateRegionName functions begin

    function readRegionName(_, next) {
        logCb('Updating region_name for this data center');

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
        fs.appendFile('/mnt/usbkey/config', region, next);
    }

    function updateSapiRegionName(_, next) {
        var metadata = { region_name: regionName };
        updateApplication({ metadata: metadata }, next);
    }

    // updateRegionName functions end

    function updateRegionName(_, next) {
        var GREP = '/usr/bin/grep';
        var args = [
            'region_name',
            '/usbkey/config',
        ];

        execFile(GREP, args, function (err, stdout, stderr) {
            if (!err) {
                logCb('No need to update region_name for this data center');
                return next();
            } else if (err && err.code !== 1) {
                err.stdout = stdout;
                err.stderr = stderr;
                return next(err);
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
        var GREP = '/usr/bin/grep';
        var args = [
            'sapi_domain',
            '/usbkey/extra/joysetup/node.config',
        ];

        execFile(GREP, args, function (err, stdout, stderr) {
            if (!err) {
                logCb('sapi_domain already present on node.config');
                return next();
            } else if (err && err.code !== 1) {
                err.stdout = stdout;
                err.stderr = stderr;
                return next(err);
            }

            logCb('Appending sapi_domain to node.config');

            var sapiDomain = 'sapi_domain=\'sapi.' + domain + '\'\n';
            var nodeConfig = '/usbkey/extra/joysetup/node.config';
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
    'Update specific values in components that don\'t fall into a specific\n'
    + 'category.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} update-other\n'
    + '\n'
);



//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
