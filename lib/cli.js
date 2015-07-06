/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The 'sdcadm' CLI class.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var sprintf = require('extsprintf').sprintf;
var strsplit = require('strsplit');
var tabula = require('tabula');
var vasync = require('vasync');
var uuid = require('node-uuid');

var common = require('./common');
var errors = require('./errors');
var logging = require('./logging');
var SdcAdm = require('./sdcadm');
var experimental = require('./experimental');
var PostSetupCLI = require('./post-setup').PostSetupCLI;
var PlatformCLI = require('./platform').PlatformCLI;
var ChannelCLI = require('./channel').ChannelCLI;



//---- globals

var pkg = require('../package.json');
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- CLI class

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

    // Generate a UUID we can use both for logs and sdcadm history:
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
    this.log = logging.createLogger({
        name: pkg.name,
        component: logComponent,    // typically the subcmd name
        logToFile: logToFile,       // whether to always log to a file
        verbose: Boolean(opts.verbose)
    });

    // Log the invocation args (trim out dashdash meta vars).
    var trimmedOpts = common.objCopy(opts);
    delete trimmedOpts._args;
    delete trimmedOpts._order;
    this.log.debug({opts: trimmedOpts, args: args, cli: true}, 'cli init');

    if (opts.version) {
        var buildstampPath = path.resolve(__dirname, '..', 'etc',
            'buildstamp');
        fs.readFile(buildstampPath, 'utf8', function (err, data) {
            if (err) {
                return callback(err);
            }
            var buildstamp = data.trim();
            p('%s %s (%s)', self.name, pkg.version, buildstamp);
            callback(false);
        });
        return;
    }
    this.opts = opts;
    if (opts.verbose) {   //XXX drop this when switching to cmdln v2
        process.env.DEBUG = 1;
    }

    /**
     * Call this to emit a progress message to the "user" on stdout.
     * Takes args like `console.log(...)`.
     */
    this.progress = function progress() {
        var args_ = Array.prototype.slice.call(arguments);
        self.log.debug.apply(self.log, [ {progress: true} ].concat(args_));
        console.log.apply(null, args_);
    };

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.call(this, opts, args, function (err) {
        if (err || err === false) {
            return callback(err);
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



CLI.prototype.do_self_update = function do_self_update(subcmd, opts,
                                                       args, callback) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    self.sdcadm.selfUpdate({
        progress: this.progress,
        allowMajorUpdate: opts.allow_major_update,
        dryRun: opts.dry_run
    }, callback);
};
CLI.prototype.do_self_update.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually updating.'
    },
    {
        names: ['allow-major-update'],
        type: 'bool',
        help: 'Allow a major version update to sdcadm. By default major ' +
               'updates are skipped (to avoid accidental backward ' +
               'compatibility breakage).'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image, even if it is ' +
            'not the default one.'
    }
];
CLI.prototype.do_self_update.help = (
    'Update "sdcadm" itself.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} self-update [<options>]\n' +
    '\n' +
    '{{options}}'
);
CLI.prototype.do_self_update.logToFile = true;



CLI.prototype.do_instances = function do_instances(subcmd, opts, args,
                                                   callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    }

    var validTypes = ['vm', 'agent'];
    var listOpts = {};
    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        var k = 'svc';
        var v = arg;
        var equal = arg.indexOf('=');
        if (equal !== -1) {
            k = arg.slice(0, equal);
            v = arg.slice(equal + 1);
        }
        switch (k) {
        case 'svc':
            if (!listOpts.svcs) {
                listOpts.svcs = [];
            }
            listOpts.svcs.push(v);
            break;
        case 'type':
            if (validTypes.indexOf(v) === -1) {
                return callback(new errors.UsageError(
                    'invalid instance type: ' + v));
            }
            if (!listOpts.types) {
                listOpts.types = [];
            }
            listOpts.types.push(v);
            break;
        default:
            return callback(new errors.UsageError(
                'unknown filter "' + k + '"'));
        }
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.sdcadm.listInsts(listOpts, function (err, insts) {
        if (err) {
            return callback(err);
        }

        var rows = insts;
        if (opts.group_by_image) {
            var rowFromTypeSvcImage = {};
            for (var j = 0; j < insts.length; j++) {
                var inst = insts[j];
                // `|| inst.version` necessary until agents and platforms
                // use images.
                var key = [inst.type, inst.service,
                    inst.image || inst.version].join('/');
                if (rowFromTypeSvcImage[key] === undefined) {
                    rowFromTypeSvcImage[key] = {
                        type: inst.type,
                        service: inst.service,
                        version: inst.version,
                        image: inst.image,
                        instances: [inst.instance]
                    };
                } else {
                    rowFromTypeSvcImage[key].instances.push(inst.instance);
                }
            }
            rows = Object.keys(rowFromTypeSvcImage).map(function (tsi) {
                var row = rowFromTypeSvcImage[tsi];
                row.count = row.instances.length;
                return row;
            });
            columns = ['service', 'image', 'version', 'count'];
        }

        common.sortArrayOfObjects(rows, sort);
        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
        } else {
            tabula(rows, {
                skipHeader: opts.H,
                columns: columns
            });
        }
        callback();
    });
};
CLI.prototype.do_instances.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'instance,service,hostname,version,alias',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,service,hostname,version,alias',
        help: 'Sort on the given fields. Default is ' +
            '"-type,service,hostname,version,alias".',
        helpArg: 'field1,...'
    },
    {
        names: ['group-by-image', 'I'],
        type: 'bool',
        help: 'Group by unique (service, image).'
    }
];
CLI.prototype.do_instances.aliases = ['insts'];
CLI.prototype.do_instances.help = (
    'List all (or a filtered subset of) SDC service instances.\n'
    + 'Note that "service" here includes SDC core vms and global zone agents.\n'
    + '\n'
    + 'Usage:\n'
    + '    {{name}} instances [<options>] [<filter>...]\n'
    + '\n'
    + '{{options}}\n'
    + 'Instances can be filtered via <filter> by type:\n'
    + '    type=vm\n'
    + '    type=agent\n'
    + 'and service name:\n'
    + '    svc=imgapi\n'
    + '    imgapi\n'
    + '    cnapi cn-agent\n'
);


CLI.prototype.do_services = function do_services(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    var i;
    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);
    var needInsts = opts.json || ~columns.indexOf('insts');

    function getInstsIfNecessary(next) {
        if (!needInsts) {
            return next();
        }
        self.sdcadm.listInsts(next);
    }

    getInstsIfNecessary(function (iErr, insts) {
        if (iErr) {
            return callback(iErr);
        }
        self.sdcadm.getServices({}, function (err, svcs) {
            if (err) {
                return callback(err);
            }

            if (needInsts) {
                var countFromSvcName = {};
                for (i = 0; i < insts.length; i++) {
                    var svcName = insts[i].service;
                    if (countFromSvcName[svcName] === undefined) {
                        countFromSvcName[svcName] = 1;
                    } else {
                        countFromSvcName[svcName]++;
                    }
                }
                for (i = 0; i < svcs.length; i++) {
                    svcs[i].insts = countFromSvcName[svcs[i].name] || 0;
                }
            }

            if (opts.json) {
                console.log(JSON.stringify(svcs, null, 4));
            } else {
                var validFieldsMap = {};
                var rows = svcs.map(function (svc) {
                    if (svc.type === 'vm') {
                        return {
                            type: svc.type,
                            uuid: svc.uuid,
                            name: svc.name,
                            image: svc.params && svc.params.image_uuid,
                            insts: svc.insts
                        };
                    } else if (svc.type === 'agent') {
                        return {
                            type: svc.type,
                            uuid: svc.uuid,
                            name: svc.name,
                            image: null,
                            insts: svc.insts
                        };
                    } else {
                        self.log.warn({svc: svc}, 'unknown service type');
                    }
                }).filter(function (svc) {
                    // Filter out `undefined` entries.
                    return svc;
                });
                rows.forEach(function (v) {
                    for (var k in v) {
                        validFieldsMap[k] = true;
                    }
                });
                tabula(rows, {
                    skipHeader: opts.H,
                    columns: columns,
                    sort: sort,
                    validFields: Object.keys(validFieldsMap)
                });
            }
            callback();
        });
    });
};
CLI.prototype.do_services.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'type,uuid,name,image,insts',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,name',
        help: 'Sort on the given fields. Default is "-type,name".',
        helpArg: 'field1,...'
    }
];
CLI.prototype.do_services.aliases = ['svcs'];
CLI.prototype.do_services.help = (
    'List all SDC services.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} services [<options>]\n'
    + '\n'
    + '{{options}}'
);

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
                return next();
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
                        return next(new errors.UsageError(
                            'unknown service: ' + parts[1]));
                    }
                } else {
                    if (svcFromName[svcOrInst] !== undefined) {
                        svc = svcOrInst;
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
                changes.push(change);
            }
            self.log.info({changes: changes}, 'getSpecFromArgs');
            next();
        },
        function getSpecFromAllServices(_, next) {
            if (args.length !== 0 || !opts.all) {
                return next();
            }
            self.log.debug('getSpecFromAllServices');

            // All unresolved services from M3 go here.
            var unsupportedInsts = ['nat', 'hostvolume'];
            // Explicit and separate array to show which instances are locked
            // and therefore not available to udpate with --all
            var lockedInsts = [
                'portolan',
                'rabbitmq',
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
            var allUnsupported = unsupportedInsts.concat(lockedInsts);

            // Anything to be excluded will be added to the allUnsupported
            // array:
            if (opts.exclude) {
                allUnsupported = allUnsupported.concat(opts.exclude);
            }

            changes = Object.keys(svcFromName).filter(function (name) {
                // Service agents are not supported, so we keep populating
                // unsupportedInsts with the ones we find
                if (svcFromName[name].type === 'agent') {
                    allUnsupported.push(name);
                    return false;
                }

                // HEAD-2167 sdcsso has been removed, but the service still
                // exists in some SDC installs (e.g. JPC), so drop update
                // attempts of it.
                if (name === 'sdcsso') {
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

CLI.prototype.do_avail = function do_avail(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    // This is always true when nothing is given:
    if (args.length === 0) {
        opts.all = true;
    }

    var changes;
    var plan;

    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    vasync.pipeline({funcs: [
        function getChangesFromArgs(_, next) {
            self._specFromArgs(opts, args, function (err, chgs) {
                if (err) {
                    return next(err);
                }
                changes = chgs;
                return next();
            });
        },
        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                forceDataPath: false,
                forceRabbitmq: false,
                forceSameImage: false,
                forceBypassMinImage: true,
                changes: changes,
                justImages: false,
                updateAll: opts.all,
                progress: self.progress,
                uuid: self.uuid,
                keepAllImages: opts.all_images,
                noVerbose: true
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        }
        ]}, function availCb(err) {
        if (err) {
            return cb(err);
        }


        var rows = [];

        var chgs = plan.changes.slice();
        chgs.forEach(function (ch) {
            if (ch.images && ch.images.length > 1) {
                ch.images.forEach(function (i) {
                    rows.push({
                        service: ch.service.name,
                        image: i.uuid,
                        version: i.name + '@' + i.version
                    });
                });

            } else {
                var img = ch.image;
                rows.push({
                    service: ch.service.name,
                    image: img.uuid,
                    version: img.name + '@' + img.version
                });
            }
        });


        if (opts.json || opts.jsonstream) {
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 4));
            } else {
                rows.forEach(function (k) {
                    process.stdout.write(JSON.stringify(k) + '\n');
                });
            }
            return cb();
        }

        var validFieldsMap = {};

        rows.forEach(function (v) {
            var k;
            for (k in v) {
                validFieldsMap[k] = true;
            }
        });

        tabula(rows, {
            skipHeader: opts.H,
            columns: columns,
            sort: sort,
            validFields: Object.keys(validFieldsMap)
        });
        return cb();
    });
};
CLI.prototype.do_avail.aliases = ['available'];
CLI.prototype.do_avail.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to search for the image(s), even if it' +
            ' is not the default one.'
    },
    {
        names: ['all-images', 'a'],
        type: 'bool',
        help: 'Display all the images available for updates, not only the ' +
            'latest image for each service.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show platforms list as raw JSON. Other options will not apply'
    },
    {
        names: [ 'jsonstream', 'J' ],
        type: 'bool',
        help: 'new-line separated JSON streaming output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'service,image,version',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: 'service,version,image',
        help: 'Sort on the given fields. Default is ' +
            '"service,version,image".',
        helpArg: 'field1,...'
    },
    {
        names: ['exclude', 'x'],
        type: 'arrayOfString',
        help: 'Exclude the given services (only when looking for updates ' +
              'for all services, i.e. no arguments given)'
    }
];
CLI.prototype.do_avail.help = (
    'Display images available for update of SDC services and instances.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} avail(able) [<options>] [<svc>] ...\n'
    + 'Examples:\n'
    + '     # Display latest available image for the cnapi service\n'
    + '     {{name}} avail cnapi\n'
    + '\n'
    + '     # Available images for all the services (the default):\n'
    + '     {{name}} avail\n'
    + '\n'
    + '     # TODO: Single instance available/update\n'
    + '     # Display latest available image for binder0 instance\n'
    + '     {{name}} avail binder0\n'
    + '\n'
    + '{{options}}'
);
// Mmmmm ...
CLI.prototype.do_avail.logToFile = true;


CLI.prototype.do_update = function do_update(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var unlock;
    var changes;
    var plan;
    var execStart;

    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    vasync.pipeline({funcs: [
        /**
         * Also see 'sdcadm update' section in docs/index.md.
         *
         *      sdcadm update <svc> ...
         *      sdcadm update <svc>@<image> ...
         *      sdcadm update <svc>@<version> ...
         *      sdcadm update <inst> ...
         *      sdcadm update <inst>@<image> ...
         *      sdcadm update <inst>@<version> ...
         *      sdcadm -f <upgrade-spec-file.json>
         *      echo <upgrade-spec-file.json> | sdcadm update
         *      sdcadm update -a|--all
         *
         * Where a <svc> is one from `sdcadm.getServices()` and <inst> is one
         * of "<zone-uuid>", "<zone-alias>" or "<server-uuid>/<agent-svc>".
         *
         * TODO: Do we need the stdin option?
         *
         *      [
         *          {"service": "cnapi", "image": "<uuid-or-local-path>"},
         *          {"service": "provisioner", "image": "<uuid-or-local-path>"},
         *          ...
         *      ]
         */
        function getChangesFromStdin(_, next) {
            if (args.length !== 0 || opts.all) {
                return next();
            } else if (process.stdin.isTTY) {
                return next(new errors.UsageError(
                    'If updating all instances, --all is a required option.'));
            }
            var chunks = [];
            process.stdin.setEncoding('utf8');
            process.stdin.on('readable', function () {
                var chunk = process.stdin.read();
                if (chunk) {
                    chunks.push(chunk);
                }
            });
            process.stdin.on('end', function () {
                try {
                    changes = JSON.parse(chunks.join(''));
                } catch (ex) {
                    return next(new errors.UsageError(ex,
                        'input is not valid JSON'));
                }
                if (!Array.isArray(changes)) {
                    changes = [changes];
                }
                next();
            });
        },
        function getLock(_, next) {
            self.sdcadm.acquireLock({progress: self.progress},
                                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function getChangesFromArgs(_, next) {
            if (changes) {
                return next();
            }
            self._specFromArgs(opts, args, function (err, chgs) {
                if (err) {
                    return next(err);
                }
                changes = chgs;
                return next();
            });
        },
        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                forceDataPath: opts.force_data_path,
                forceRabbitmq: opts.force_rabbitmq,
                forceSameImage: opts.force_same_image,
                forceBypassMinImage: opts.force_bypass_min_image,
                changes: changes,
                justImages: opts.just_images,
                updateAll: opts.all,
                progress: self.progress,
                uuid: self.uuid
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        },
        function confirm(_, next) {
            if (plan.procs.length === 0) {
                return next();
            }
            p('');
            p('This update will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting update');
                    return cb();
                }
                p('');
                next();
            });
        },
        function execPlan(_, next) {
            execStart = Date.now();
            if (plan.procs.length === 0) {
                return next();
            }
            if (opts.dry_run) {
                p('[dry-run] done');
                return next();
            }
            self.sdcadm.execUpdatePlan({
                plan: plan,
                progress: self.progress,
                dryRun: opts.dry_run,
                justImages: opts.just_images,
                uuid: self.uuid
            }, next);
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    return next();
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                self.log.fatal({err: finishUpErr},
                    'unexpected error finishing up update');
            }
            if (err || finishUpErr) {
                return cb(err || finishUpErr);
            }

            if (plan.procs.length === 0) {
                if (opts.just_images) {
                    p('Up-to-date (all images are imported).');
                } else {
                    p('Up-to-date.');
                }
            } else {
                p('Updated successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });
};
CLI.prototype.do_update.aliases = ['up'];
CLI.prototype.do_update.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually updating.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Update all instances.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['just-images', 'I'],
        type: 'bool',
        help: 'Just import images. Commonly this is used to preload images '
            + 'before the full upgrade run.'
    },
    {
        names: ['force-data-path'],
        type: 'bool',
        help: 'Upgrade components in the customer data path (portolan)'
    },
    {
        names: ['force-rabbitmq'],
        type: 'bool',
        help: 'Forcibly update rabbitmq (which is not updated by default)'
    },
    {
        names: ['force-same-image'],
        type: 'bool',
        help: 'Allow update of an instance(s) even if the target image is '
            + 'the same as the current.'
    },
    {
        names: ['force-bypass-min-image'],
        type: 'bool',
        help: 'Allow update of an instance(s) even if the target image is '
            + 'unknown or it does not fulfil the minimum image '
            + 'requirements for updates.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image(s), even if it is ' +
            'not the default one.'
    },
    {
        names: ['exclude', 'x'],
        type: 'arrayOfString',
        help: 'Exclude the given services (only when -a|--all is provided)'
    }
];
CLI.prototype.do_update.help = (
    'Update SDC services and instances.\n'
    + '\n'
    + 'Usage:\n'
    + '     ...update spec on stdin... | {{name}} update [<options>]\n'
    + '     {{name}} update [<options>] <svc> ...\n'
    + '     {{name}} update [<options>] <svc>@<image> ...\n'
    + '     {{name}} update [<options>] <svc>@<version> ...\n'
    + '     {{name}} update [<options>] <inst> ...\n'
    + '     {{name}} update [<options>] <inst>@<image> ...\n'
    + '     {{name}} update [<options>] <inst>@<version> ...\n'
    + '\n'
    + 'Examples:\n'
    + '     # Update all instances of the cnapi service to the latest\n'
    + '     # available image.\n'
    + '     {{name}} update cnapi\n'
    + '\n'
    + '     TODO: other calling forms\n'
    + '\n'
    + '{{options}}'
);
CLI.prototype.do_update.logToFile = true;


CLI.prototype.do_rollback = function do_rollback(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    // TODO: When no file is given, read latest from /var/sdcadm/updates
    // (or maybe just add '--latest' option, like for platform cmd)
    if (!opts.file) {
        return cb(new errors.UsageError('File including update plan ' +
                    'to rollback must be specified'));
    }

    if (!opts.force) {
        return cb(new errors.UsageError('Migrations and version ' +
            'dependencies not implemented. Use "--force" to rollback ' +
            '(warning: you know what you are doing w.r.t. migrations).'));
    }

    var upPlan;
    var plan;
    var unlock;
    var execStart;

    vasync.pipeline({funcs: [
        function getSpecFromFile(_, next) {
            fs.readFile(opts.file, {
                encoding: 'utf8'
            }, function rfCb(err, data) {
                if (err) {
                    // TODO: InternalError
                    return next(err);
                }
                upPlan = JSON.parse(data);  // presume no parse error
                next();
            });
        },
        function getLock(_, next) {
            self.sdcadm.acquireLock({progress: self.progress},
                                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function genRbPlan(_, next) {
            self.sdcadm.genRollbackPlan({
                updatePlan: upPlan
            }, function (err, _plan) {
                if (err) {
                    return next(err);
                }
                plan = _plan;
                next();
            });
        },

        function confirm(_, next) {
            if (plan.procs.length === 0) {
                return next();
            }
            p('');
            p('This rollback will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting rollback');
                    return cb();
                }
                p('');
                next();
            });
        },

        function execPlan(_, next) {
            execStart = Date.now();
            if (plan.procs.length === 0) {
                return next();
            }
            if (opts.dry_run) {
                p('[dry-run] done');
                return next();
            }
            self.sdcadm.execUpdatePlan({
                plan: plan,
                progress: self.progress,
                dryRun: opts.dry_run,
                uuid: self.uuid,
                upDir: path.dirname(opts.file)
            }, next);
        }
    ]
    }, function finishRb(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    return next();
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishRbErr) {
            // We shouldn't ever get a `finishRbErr`. Let's be loud if we do.
            if (finishRbErr) {
                self.log.fatal({err: finishRbErr},
                    'unexpected error finishing up rollback');
            }
            if (err || finishRbErr) {
                return cb(err || finishRbErr);
            }

            if (plan.procs.length === 0) {
                p('Nothing to rollback');
            } else {
                p('Rolledback successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });
};


CLI.prototype.do_rollback.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually rolling back.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['force'],
        type: 'bool',
        help: 'Do the rollback despite of migrations and version dependencies'
    },
    {
        names: ['file', 'f'],
        type: 'string',
        help: 'Full path to file with update plan.json to rollback',
        helpArg: 'FILE_PATH'
    }
];


CLI.prototype.do_rollback.help = (
    'Rollback SDC services and instances.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} rollback [<options>] -f <./local-upgrade-file.json> ...\n'
    + '\n'
    + '{{options}}'
);

CLI.prototype.do_rollback.logToFile = true;

CLI.prototype.do_create = function do_create(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var unlock;
    var svcs;
    var svcFromName;
    var changes = [];
    var plan;
    var execStart;

    vasync.pipeline({funcs: [
        function getLock(_, next) {
            self.sdcadm.acquireLock({progress: self.progress},
                                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function getSvcs(_, next) {
            self.sdcadm.getServices({}, function (err, svcs_) {
                svcs = svcs_;
                svcFromName = {};
                var i;
                for (i = 0; i < svcs.length; i += 1) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },
        function getChangeFromArgs(_, next) {
            if (args.length === 0) {
                return next(new errors.UsageError(
                    'Must specify service name or uuid'));
            }

            var service = args[0];
            var change = {};
            if (svcFromName[service] === undefined) {
                return next(new errors.UsageError(
                    'unknown service: ' + service));
            }

            change.service = args[0];

            if (opts.image) {
                change.image = opts.image;
            } else {
                change.image = svcFromName[service].params.image_uuid;
            }

            if (!opts.server) {
                return next(new errors.UsageError(
                    'Must specify server uuid'));
            }
            change.server = opts.server;
            change.type = 'create';
            changes.push(change);
            next();
        },

        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                changes: changes,
                progress: self.progress,
                uuid: self.uuid,
                skipHACheck: opts.skip_ha_check
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        },
        function confirm(_, next) {
            if (plan.procs.length === 0) {
                return next();
            }
            p('');
            p('This command will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    return cb();
                }
                p('');
                next();
            });
        },
        function execPlan(_, next) {
            execStart = Date.now();
            if (plan.procs.length === 0) {
                return next();
            }
            if (opts.dry_run) {
                p('[dry-run] done');
                return next();
            }
            self.sdcadm.execUpdatePlan({
                plan: plan,
                progress: self.progress,
                uuid: self.uuid
            }, next);
        }
    ]}, function finishCreate(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    return next();
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishCreateErr) {
            // We shouldn't ever get a `finishCreateErr`.
            // Let's be loud if we do.
            if (finishCreateErr) {
                self.log.fatal({err: finishCreateErr},
                    'unexpected error finishing create');
            }
            if (err || finishCreateErr) {
                return cb(err || finishCreateErr);
            }

            if (plan.procs.length === 0) {
                p('No-op.');
            } else {
                p('Created successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });
};


CLI.prototype.do_create.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually creating.'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'UUID of the Image to be used for the instance.'
    },
    {
        names: ['server', 's'],
        type: 'string',
        help: 'The UUID for the target server.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['skip-ha-check'],
        type: 'bool',
        help: 'Allow create the instance even if the service is not '
            + 'HA ready.'
    }
];

CLI.prototype.do_create.help = (
    'Create an instance for an existing SDC service.\n' +
    '\n' +
    'Usage:\n\n' +
    '       sdcadm create <svc>\n\n' +
    'Note that in order to create an instance of some services the option\n' +
    '--skip-ha-ready must be specified, given that those services are not\n' +
    'supposed to have more than one instance. There are also some services\n' +
    'which are not allowed to have more than one instance, or services\n' +
    'whose instances should not be created using this tool, like manatee or\n' +
    'zookeeper. Finally, the first instance of some services should not be\n' +
    'created using this tool when there is an alternate choice provided by\n' +
    'post-setup subcommand.\n' +
    '\n' +
    '{{options}}'
);

CLI.prototype.do_create.logToFile = true;


CLI.prototype.do_check_config = function do_check_config(subcmd, opts,
                                                       args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    this.sdcadm.checkConfig({}, function (err, errs) {
        if (err) {
            callback(err);
        } else {
            if (errs && errs.length) {
                errs.forEach(function (er) {
                    console.error(er);
                });
                callback();
            } else {
                console.info('All good!');
                callback();
            }
        }
    });
};
CLI.prototype.do_check_config.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_check_config.help = (
    'Check sdc config in SAPI versus system reality.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} check-config [<options>]\n'
    + '\n'
    + '{{options}}'
);
CLI.prototype.do_check_config.logToFile = false;


CLI.prototype.do_check_health =
function do_check_health(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        return self.do_help('help', {}, [subcmd], callback);
    }

    if (args.length === 0) {
        return self.sdcadm.checkHealth({}, displayResults);
    }

    var names = {};
    var uuids = [];

    args.forEach(function (arg) {
        if (arg.match(UUID_RE)) {
            uuids.push(arg);
        } else {
            names[arg] = true;
        }
    });

    vasync.pipeline({ funcs: [
        function getSvcs(_, next) {
            replaceNamesWithUuids('getServices', next);
        },
        function getInsts(_, next) {
            replaceNamesWithUuids('listInsts', next);
        }
    ]}, function (err) {
        if (err) {
            return callback(new errors.InternalError(err));
        }

        if (Object.keys(names).length > 0) {
            var msg = 'unrecognized service or instance: ' +
                Object.keys(names).join(', ');
            return callback(new errors.UsageError(msg));
        }

        return self.sdcadm.checkHealth({ uuids: uuids }, displayResults);
    });

    function replaceNamesWithUuids(funcName, cb) {
        if (Object.keys(names).length === 0) {
            return cb();
        }
        self.sdcadm[funcName]({}, function (err, objs) {
            if (err) {
                return cb(err);
            }

            objs.forEach(function (obj) {
                if (names[obj.name] && obj.uuid) {
                    uuids.push(obj.uuid);
                    delete names[obj.name];
                } else if (names[obj.alias] && obj.instance) {
                    uuids.push(obj.instance);
                    delete names[obj.alias];
                }
            });

            cb();
        });
    }

    function displayResults(err, statuses) {
        if (err) {
            return callback(new errors.InternalError(err));
        }

        var rows = statuses.map(function (status) {
            var obj = {
                type:      status.type,
                instance:  status.instance,
                alias:     status.alias,
                service:   status.service,
                hostname:  status.hostname,
                healthy:   status.healthy
            };

            if (status.health_errors) {
                obj.health_errors = status.health_errors;
            }

            return obj;
        });


        var errRows = rows.filter(function (row) {
            return row.health_errors;
        });

        var sortAttr = ['-type', 'service', 'hostname', 'instance'];
        common.sortArrayOfObjects(rows, sortAttr);

        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
        } else {
            if (!opts.quiet) {
                var columns = ['instance', 'service', 'hostname', 'alias',
                               'healthy'];

                tabula(rows, {
                    skipHeader: opts.H,
                    columns: columns
                });
            }

            errRows.forEach(function (row) {
                row.health_errors.forEach(function (errObj) {
                    console.error((row.instance || row.service),
                            errObj.message);
                });
            });
        }

        if (errRows.length > 0) {
            return callback(new Error('Some instances appear unhealthy'));
        }

        return callback();
    }
};
CLI.prototype.do_check_health.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    },
    {
        names: ['quiet', 'q'],
        type: 'bool',
        help: 'Only print health errors, if any'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    }
];
CLI.prototype.do_check_health.aliases = ['health'];
CLI.prototype.do_check_health.help = (
    'Check that services or instances are up.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} check-health [<options>] [<svc or inst>...]\n'
    + '\n'
    + '{{options}}'
);
CLI.prototype.do_check_health.logToFile = false;


CLI.prototype.do_experimental = experimental.ExperimentalCLI;
CLI.prototype.do_experimental.hidden = true;
CLI.prototype.do_experimental.logToFile = true;


CLI.prototype.do_post_setup = PostSetupCLI;
CLI.prototype.do_post_setup.logToFile = true;

CLI.prototype.do_platform = PlatformCLI;
CLI.prototype.do_platform.logToFile = true;

CLI.prototype.do_channel = ChannelCLI;
CLI.prototype.do_channel.logToFile = true;


CLI.prototype.do_history = function do_history(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (args.length === 1) {
        var id = args[0];
        if (!UUID_RE.test(id)) {
            return cb(new errors.UsageError('Invalid UUID: ' + id));
        }
        return self.sdcadm.history.getHistory(id, function (err, hist) {
            if (err) {
                return cb(err);
            }
            console.log(JSON.stringify(hist, null, 4));
            return cb();
        });
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);
    var options = {};

    if (opts.since) {
        try {
            options.since = new Date(opts.since.trim()).toISOString();
        } catch (e) {
            return cb(new errors.UsageError('Invalid Date: ' +
                        opts.since.trim()));
        }
    }

    if (opts.until) {
        try {
            options.until = new Date(opts.until.trim()).toISOString();
        } catch (e) {
            return cb(new errors.UsageError('Invalid Date: ' +
                        opts.until.trim()));
        }
    }

    return self.sdcadm.history.listHistory(options, function (err, history) {
        if (err) {
            return cb(err);
        }

        if (opts.json) {
            console.log(JSON.stringify(history, null, 4));
        } else {
            var validFieldsMap = {};
            if (!history.length) {
                return cb();
            }
            var rows = history.map(function (hst) {
                var chgs;
                // Only set changes value when it's in a known format:
                if (hst.changes && Array.isArray(hst.changes)) {
                    chgs = hst.changes.map(function (c) {
                        if (!c.type || !c.service) {
                            return ('');
                        }
                        return (c.type + '(' + c.service.name + ')');
                    }).join(',');
                }
                var row = {
                    uuid: hst.uuid,
                    changes: chgs,
                    started: (hst.started ?
                        new Date(hst.started).toJSON() : null),
                    finished: (hst.finished ?
                        new Date(hst.finished).toJSON() : null),
                    error: (hst.error?
                        (hst.error.message ?
                         hst.error.message.split('\n', 1)[0] :
                         hst.error) : null),
                    user: hst.username ? hst.username : null
                };

                if (row.changes.length > 40) {
                    row.changes = row.changes.substring(0, 40) + '...';
                }

                if (row.error && row.error.length > 40) {
                    row.error = row.error.substring(0, 40) + '...';
                }

                return row;
            });
            rows.forEach(function (v) {
                for (var k in v) {
                    validFieldsMap[k] = true;
                }
            });
            tabula(rows, {
                skipHeader: opts.H,
                columns: columns,
                sort: sort,
                validFields: Object.keys(validFieldsMap)
            });
        }
        return cb();
    });
};

CLI.prototype.do_history.help = (
    'History of sdcadm commands.\n' +
    '\n' +
    'The historical collection of sdcadm commands ran into the current\n' +
    'SDC setup, searchable by execution time (when SAPI is available).\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} history [<options>] [HISTORY-ITEM-UUID]\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'When HISTORY-ITEM-UUID is given, only that history item will\n' +
    'be included using JSON format and all the other options will\n' +
    'be ignored'
);
CLI.prototype.do_history.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show history as JSON.'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'uuid,user,started,finished,changes,error',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-started,finished',
        help: 'Sort on the given fields. Default is "-started,finished".',
        helpArg: 'field1,...'
    },
    {
        names: ['since'],
        type: 'string',
        help: 'Return only values since the given date. ISO 8601 Date String.'
    },
    {
        names: ['until'],
        type: 'string',
        help: 'Return only values until the given date. ISO 8601 Date String.'
    }
];
CLI.prototype.do_history.logToFile = false;



//---- exports

module.exports = CLI;



//---- mainline

if (require.main === module) {
    var cli = new CLI();
    cmdln.main(cli, process.argv, {
        showCode: true,
        showErr: true
    });
}
