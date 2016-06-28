/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Collection of 'sdcadm dc-maint ...' CLI commands.
 *
 * Start/stop DC maintenance and set maintenance message and expected ETA.
 */


var util = require('util');

var cmdln = require('cmdln');
var Cmdln = cmdln.Cmdln;

var common = require('./common');
var errors = require('./errors');


// --- DCMaint CLI class

function DCMaintCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm dc-maint',
        /* BEGIN JSSTYLED */
        desc: 'DC maintenance related sdcadm commands.\n' +
              '\n' +
              'Show and modify the DC maintenance mode.\n' +
              '\n' +
              '"Maintenance mode" for an SDC means that Cloud API is in read-only\n' +
              'mode. Modifying requests will return "503 Service Unavailable".\n' +
              'Likewise, if Docker is installed it will behave on the same way.\n' +
              'Workflow API will be drained on entering maint mode.\n' +
              '\n' +
              'When specified, the maintenance message will be used as part of the\n' +
              'response body for the modifying requests:\n' +
              '{\n' +
              '    "code":"ServiceUnavailableError",\n' +
              '    "message":"SmartDataCenter is being upgraded"\n' +
              '}\n' +
              '\n' +
              'Limitation: This does not current wait for config changes to be made\n' +
              'and cloudapi instances restarted. That means there is a window after\n' +
              'starting that new jobs could come in.\n',
        /* END JSSTYLED */
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        },
        options: [
            {
                names: ['help', 'h'],
                type: 'bool',
                help: 'Show this help.'
            },
            {
                names: ['json', 'j'],
                type: 'bool',
                help: 'Show status as JSON.' +
                    ' Deprecated, use `sdcadm status -j`'
            },
            {
                names: ['start'],
                type: 'bool',
                help: 'Start maintenance mode.' +
                    ' Deprecated, use `sdcadm start`'
            },
            {
                names: ['stop'],
                type: 'bool',
                help: 'Stop maintenance mode. Deprecated, use `sdcadm stop`'
            }
        ]
    });
}
util.inherits(DCMaintCLI, Cmdln);

DCMaintCLI.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;
    if (opts.help) {
        this.do_help(args[0], opts, [], function (helpErr) {
            callback(helpErr || false);
        });
        return;
    } else if (opts.start) {
        this.do_start(args[0], opts, [], function (startErr) {
            callback(startErr || false);
        });
        return;
    } else if (opts.stop) {
        this.do_stop(args[0], opts, [], function (stopErr) {
            callback(stopErr || false);
        });
        return;
    } else if (opts.json) {
        this.do_status(args[0], opts, [], function (statusErr) {
            callback(statusErr || false);
        });
        return;
    } else {
        callback();
    }
};


DCMaintCLI.prototype.do_start = function do_start(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    // TOOLS-905: We should get rid of this, it has been more than one month
    // since Nov, the 25th 2015 now.
    // Warning if used as `sdcadm experimental dc-maint`
    if (self.top.top) {
        self.progress('Warning: `sdcadm experimental dc-maint` is deprecated.' +
            '\n' + common.indent('Please use `sdcadm dc-maint` instead.',
                '         '));
    }

    if (opts.eta && opts.eta <= new Date()) {
        return cb(new errors.UsageError(
                    '--eta must be set to any time in the future'));
    }

    if (opts.cloudapi_only && opts.docker_only) {
        return cb(new errors.UsageError(
            '--cloudapi-only and --docker-only are mutually exclusive'));
    }

    self.sdcadm.dcMaintStart({
        progress: self.progress,
        eta: (opts.eta ? opts.eta.toISOString() : null),
        message: opts.message,
        cloudapiOnly: opts.cloudapi_only,
        dockerOnly: opts.docker_only
    }, cb);
};


DCMaintCLI.prototype.do_start.help = (
        'Start maintenance mode.\n' +
        '\n' +
        'Usage:\n' +
        '     {{name}} start [--eta] [--message] ' +
            '[--docker-only|--cloudapi-only]\n' +
        '\n' +
        '{{options}}'
);

DCMaintCLI.prototype.do_start.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['docker-only'],
        type: 'bool',
        help: 'Start maintenance mode only for Docker service.'
    },
    {
        names: ['cloudapi-only'],
        type: 'bool',
        help: 'Start maintenance mode only for CloudAPI service.'
    },
    {
        names: ['message'],
        type: 'string',
        default: 'SmartDataCenter is being upgraded',
        help: 'Maintenance message to be used until the DC is restored to ' +
                'full operation.'
    },
    {
        names: ['eta'],
        type: 'date',
        help: 'Expected time to get the DC restored to full ' +
              'operation (to be used in Retry-After HTTP headers).' +
              'Epoch seconds, e.g. 1396031701, or ISO 8601 format ' +
              'YYYY-MM-DD[THH:MM:SS[.sss][Z]], e.g. ' +
              '"2014-03-28T18:35:01.489Z". '
    }
];


DCMaintCLI.prototype.do_stop = function do_stop(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    // Warning if used as `sdcadm experimental dc-maint`
    if (self.top.top) {
        self.progress('Warning: `sdcadm experimental dc-maint` is deprecated.' +
            '\n' + common.indent('Please use `sdcadm dc-maint` instead.',
                '         '));
    }

    self.sdcadm.dcMaintStop({
        progress: self.progress
    }, cb);
};

DCMaintCLI.prototype.do_stop.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
DCMaintCLI.prototype.do_stop.help = (
        'Stop maintenance mode.\n' +
        '\n' +
        'Usage:\n' +
        '     {{name}} stop \n' +
        '\n' +
        '{{options}}'
);

DCMaintCLI.prototype.do_status = function do_status(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    // Warning if used as `sdcadm experimental dc-maint`
    if (self.top.top) {
        self.progress('Warning: `sdcadm experimental dc-maint` is deprecated.' +
            '\n' + common.indent('Please use `sdcadm dc-maint` instead.',
                '         '));
    }

    self.sdcadm.dcMaintStatus(function (err, status) {
        if (err) {
            return cb(err);
        }
        if (opts.json) {
            self.progress(JSON.stringify(status, null, 4));
        } else if (status.maint) {
            var word = (status.cloudapiMaint && status.dockerMaint) ? 'on' :
                (status.cloudapiMaint && !status.dockerMaint) ?
                    'cloudapi-only' : 'docker-only';
            if (status.startTime) {
                self.progress('DC maintenance: %s (since %s)',
                    word, status.startTime);
            } else {
                self.progress('DC maintenance: %s', word);
            }
            if (status.message) {
                self.progress('DC maintenance message: %s',
                        status.message);
            }
            if (status.eta) {
                self.progress('DC maintenance ETA: %s', status.eta);
            }
        } else {
            self.progress('DC maintenance: off');
        }
        cb();
    });
};

DCMaintCLI.prototype.do_status.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show status as JSON.'
    }
];
DCMaintCLI.prototype.do_status.help = (
        'Show maintenance status.\n' +
        '\n' +
        'Usage:\n' +
        '     {{name}} status \n' +
        '\n' +
        '{{options}}'
);

//---- exports

module.exports = {
    DCMaintCLI: DCMaintCLI
};
