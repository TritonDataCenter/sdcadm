/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * The 'sdcadm' CLI class.
 */

var p = console.log;
var util = require('util');
var fs = require('fs');
var path = require('path');

var cmdln = require('cmdln');
var Cmdln = cmdln.Cmdln;
var strsplit = require('strsplit');
var vasync = require('vasync');
var uuid = require('node-uuid');
var extsprintf = require('extsprintf');

var common = require('../common');
var errors = require('../errors');
var logging = require('../logging');
var SdcAdm = require('../sdcadm');
var experimental = require('./experimental');
var PostSetupCLI = require('../post-setup').PostSetupCLI;
var PlatformCLI = require('../platform').PlatformCLI;
var ChannelCLI = require('../channel').ChannelCLI;
var DCMaintCLI = require('../dc-maint').DCMaintCLI;
var defFabric = require('../default-fabric');


// --- globals

var pkg = require('../../package.json');
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


// --- Custom dashdash option types

function parseCommaSepStringNoEmpties(_option, _optstr, arg) {
    /* JSSTYLED */
    return arg.trim().split(/\s*,\s*/g).filter(function (part) {
        return part;
    });
}

cmdln.dashdash.addOptionType({
    name: 'commaSepString',
    takesArg: true,
    helpArg: 'STRING',
    parseArg: parseCommaSepStringNoEmpties
});

cmdln.dashdash.addOptionType({
    name: 'arrayOfCommaSepString',
    takesArg: true,
    helpArg: 'STRING',
    parseArg: parseCommaSepStringNoEmpties,
    array: true,
    arrayFlatten: true
});


// --- CLI class

function CLI() {
    Cmdln.call(this, {
        name: pkg.name,
        desc: pkg.description,
        options: [
            {names: ['help', 'h'], type: 'bool', help: 'Print help and exit.'},
            {name: 'version', type: 'bool', help: 'Print version and exit.'},
            {names: ['verbose', 'v'], type: 'bool',
                help: 'Verbose/debug output.'}
        ],
        helpOpts: {
            includeEnv: true,
            minHelpCol: 27 /* line up with option help */
        }
    });
}
util.inherits(CLI, Cmdln);

CLI.prototype.init = function init(opts, args, callback) {
    var self = this;

    // Generate a UUID we can use both logs:
    this.uuid = uuid();
    // Setup the logger.
    var handler = this.handlerFromSubcmd(args[0]);
    var logComponent = args[0] || 'nosubcmd';
    if (handler && handler.name && handler.name.slice(0, 3) === 'do_') {
        // Use this to canonicalize the name, e.g. if args[0] is 'insts',
        // but the command is canonically 'instances'.
        logComponent = handler.name.slice(3);
    }
    var logToFile = (handler && handler.logToFile || false);
    var skipInit = false;

    if (args.indexOf('help') !== -1 ||
        args.indexOf('--help') !== -1 ||
        args.indexOf('-h') !== -1 ||
        opts.help) {
        logToFile = false;
        skipInit = true;
    }

    // Wrap into try/catch block and handle ENOSPC and EACCES with friendlier
    // messages:
    try {
        this.log = logging.createLogger({
            name: pkg.name,
            component: logComponent,    // typically the subcmd name
            logToFile: logToFile,       // whether to always log to a file
            verbose: Boolean(opts.verbose)
        });
    } catch (e) {
        if (e.code && e.code === 'ENOSPC') {
            callback(new Error('Not enought space to create log file'));
            return;
        } else if (e.code && e.code === 'EACCES') {
            callback(new Error(
                'Insufficient permissions to create log file'));
            return;
        } else {
            callback(e);
            return;
        }
    }

    // Log the invocation args (trim out dashdash meta vars).
    var trimmedOpts = common.objCopy(opts);
    delete trimmedOpts._args;
    delete trimmedOpts._order;
    this.log.debug({opts: trimmedOpts, args: args, cli: true}, 'cli init');

    if (opts.version) {
        var buildstampPath = path.resolve(__dirname, '..', '..', 'etc',
            'buildstamp');
        fs.readFile(buildstampPath, 'utf8', function (err, data) {
            if (err) {
                callback(err);
                return;
            }
            var buildstamp = data.trim();
            p('%s %s (%s)', self.name, pkg.version, buildstamp);
            callback(false);
        });
        return;
    }
    this.opts = opts;

    /**
     * Call this to emit a progress message to the "user" on stdout.
     * Takes args like `console.log(...)`.
     */
    this.progress = function progress() {
        var args_ = Array.prototype.slice.call(arguments);
        var msg = extsprintf.sprintf.apply(null, args_);
        self.log.debug({progress: true}, msg);
        console.log(msg);
    };

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.call(this, opts, args, function (err) {
        if (err || err === false) {
            callback(err);
            return;
        }

        /*
         * Initializing `SdcAdm` involves some processing (getting config from
         * SAPI, running /lib/sdc/config.sh, etc.) that we don't need (or
         * *want*, e.g. if SAPI is down) for some `sdcadm` commands. We'll
         * manually skip for those here.
         */
        var skipInitCmds = {completion: true, help: true};
        if (skipInit || (args[0] && skipInitCmds[args[0]])) {
            callback();
            return;
        }

        self.sdcadm = new SdcAdm({
            log: self.log,
            uuid: self.uuid
        });
        self.sdcadm.init(callback);
    });
};


/**
 * Finalize the command call before exiting: log exit status, flush logs.
 */
CLI.prototype.fini = function fini(subcmd, err, cb) {
    if (this.opts && this.opts.verbose) {
        this.showErrStack = true; // turn this on for `cmdln.main()`
    }

    if (this.sdcadm) {
        this.sdcadm.fini();
    }

    if (this.log) {  // On an early error we might not have `log`.
        var exitStatus = (err ? err.exitStatus || 1 : 0);
        var logLevel = 'debug';
        if (err && this.opts && this.opts.verbose) {
            logLevel = 'error';
        }
        this.log[logLevel]({subcmd: subcmd, exitStatus: exitStatus, cli: true},
            'cli exit');

        logging.flushLogs([this.log], cb);
    } else {
        cb();
    }
};


CLI.prototype.do_self_update = require('./do_self_update').do_self_update;

CLI.prototype.do_instances = require('./do_instances').do_instances;

CLI.prototype.do_services = require('./do_services').do_services;

// Shared by do_update and do_available:
CLI.prototype._specFromArgs = function _specFromArgs(opts, args, cb) {
    var self = this;
    var svcs;
    var svcFromName;
    var changes;

    vasync.pipeline({funcs: [
        function getSvcs(_, next) {
            // TODO: get this cached so we can avoid call in `genUpdatePlan`
            self.sdcadm.getServices({}, function (err, svcs_) {
                svcs = svcs_;
                svcFromName = {};
                for (var i = 0; i < svcs.length; i++) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },
        function getSpecFromArgs(_, next) {
            if (args.length === 0) {
                next();
                return;
            }
            changes = [];
            for (var i = 0; i < args.length; i++) {
                var parts = strsplit(args[i], '@', 2);
                var svcOrInst = parts[0];
                var verOrImg;
                if (parts.length > 1) {
                    verOrImg = parts[1];
                }
                var svc = null;
                var inst = null;
                parts = strsplit(svcOrInst, '/', 2);
                if (parts.length > 1) {
                    // server = parts[0];
                    inst = svcOrInst;
                    if (svcFromName[parts[1]] === undefined) {
                        next(new errors.UsageError(
                            'unknown service: ' + parts[1]));
                        return;
                    }
                } else {
                    if (svcFromName[svcOrInst] !== undefined) {
                        svc = svcOrInst;
                    // For the case it's not yet installed:
                    } else if (svcOrInst === 'dockerlogger') {
                        svc = 'dockerlogger';
                        svcFromName[svc] = {
                            type: 'other'
                        };
                    } else {
                        inst = svcOrInst;
                    }
                }
                var ver = null;
                var img = null;
                if (UUID_RE.test(verOrImg)) {
                    img = verOrImg;
                } else {
                    ver = verOrImg;
                }
                var change = {};
                if (inst) {
                    change.instance = inst;
                }
                if (svc) {
                    change.service = svc;
                }
                if (img) {
                    change.image = img;
                }
                if (ver) {
                    change.version = ver;
                }
                // Prevent individual agent updates out of experimental:
                if (change.service &&
                    svcFromName[change.service].type === 'agent' &&
                    !opts.experimental) {
                    continue;
                }
                changes.push(change);
            }

            self.log.info({changes: changes}, 'getSpecFromArgs');
            next();
        },
        function getSpecFromAllServices(_, next) {
            if (args.length !== 0 || !opts.all) {
                next();
                return;
            }
            self.log.debug('getSpecFromAllServices');

            // All unresolved services from M3 go here.
            var unsupportedInsts = ['nat', 'hostvolume',
                // removed agents:
                'provisioner', 'heartbeater', 'zonetracker'
            ];
            // Explicit and separate array to show which instances are locked
            // and therefore not available to udpate with --all
            var lockedInsts = [
                /*
                 * The 'zookeeper' service was a short-lived (and only ever
                 * manually installed via MORAY-138) service to provide an
                 * HA zk cluster for manatee and moray. The SDC design has
                 * moved to using a 'binder' cluster and the zk service it
                 * exposes. As a result, we want to exclude 'zookeeper' from
                 * upgrade handling and not choke on it.
                 */
                'zookeeper'
            ];
            if (!opts.force_rabbitmq) {
                lockedInsts.push('rabbitmq');
            }
            if (!opts.force_data_path) {
                lockedInsts.push('portolan');
            }
            var allUnsupported = unsupportedInsts.concat(lockedInsts);

            // Anything to be excluded will be added to the allUnsupported
            // array:
            if (opts.exclude) {
                // Allow comma separated list of services to excude, like
                // -x svc1,svc2,svc3
                var exclude = [];
                opts.exclude.map(function (i) {
                    return (i.split(','));
                }).forEach(function (a) {
                    exclude = exclude.concat(a);
                });

                allUnsupported = allUnsupported.concat(exclude);
            }

            changes = Object.keys(svcFromName).filter(function (name) {
                // Service agents are not supported, so we keep populating
                // unsupportedInsts with the ones we find
                if (svcFromName[name].type === 'agent' && !opts.experimental) {
                    allUnsupported.push(name);
                    return false;
                }

                // For now, we only want to allow 'dockerlogger' service
                // updates when using `sdcadm experimental update`:
                if (!opts.experimental && name === 'dockerlogger') {
                    allUnsupported.push('dockerlogger');
                    return false;
                }

                // HEAD-2167 sdcsso has been removed, but the service still
                // exists in some SDC installs (e.g. JPC), so drop update
                // attempts of it.
                // PORTAL-2801 sdcsso and piranha service config are now
                // managed with SAPI. Some SDC installs may have them but
                // update is still managed outside of sdcadm.
                if (name === 'sdcsso' || name === 'piranha') {
                    return false;
                }
                // ditto for vcapi
                if (name === 'vcapi') {
                    return false;
                }

                return (allUnsupported.indexOf(name) === -1);
            }).map(function (name) {
                return { service: name };
            });

            // If 'dockerlogger' service doesn't exist yet, but logger has been
            // setup, we want to be able to setup dockerlogger too:
            if (svcFromName['docker'] && !svcFromName['dockerlogger'] &&
                    opts.experimental) {
                changes.push({service: 'dockerlogger'});
            }

            self.log.info({changes: changes}, 'getSpecFromAllServices');
            next();
        }
    ]}, function specCb(err) {
        if (err) {
            return cb(err);
        } else {
            return cb(null, changes);
        }
    });
};

var available = require('./do_avail');
CLI.prototype.do_avail = available.do_avail;

var update = require('./do_update');
CLI.prototype.do_update = update.do_update;

var create = require('./do_create');
CLI.prototype.do_create = create.do_create;


CLI.prototype.do_rollback = require('./do_rollback').do_rollback;

CLI.prototype.do_check_config = require('./do_check_config').do_check_config;

CLI.prototype.do_check_health = require('./do_check_health').do_check_health;

CLI.prototype.do_dc_maint = DCMaintCLI;
CLI.prototype.do_dc_maint.logToFile = true;


experimental.ExperimentalCLI.prototype.do_avail =
available.do_experimental_avail;

experimental.ExperimentalCLI.prototype.do_update =
update.do_experimental_update;


CLI.prototype.do_experimental = experimental.ExperimentalCLI;
CLI.prototype.do_experimental.hidden = true;
CLI.prototype.do_experimental.logToFile = true;



CLI.prototype.do_post_setup = PostSetupCLI;
CLI.prototype.do_post_setup.logToFile = true;

CLI.prototype.do_platform = PlatformCLI;
CLI.prototype.do_platform.logToFile = true;

CLI.prototype.do_channel = ChannelCLI;
CLI.prototype.do_channel.logToFile = true;

CLI.prototype.do_default_fabric = defFabric.do_default_fabric;
CLI.prototype.do_default_fabric.logToFile = true;

CLI.prototype.do_completion = require('./do_completion');


// --- exports

module.exports = CLI;



// --- mainline

if (require.main === module) {
    var cli = new CLI();
    cmdln.main(cli, {
        argv: process.argv,
        showCode: true,
        showErr: true,
        finale: 'softexit'
    });
}
