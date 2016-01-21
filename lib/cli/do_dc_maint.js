/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var errors = require('../errors');
var common = require('../common');

/*
 * The 'sdcadm experimental dc-maint' CLI subcommand.
 */
function do_dc_maint(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    // Warning if used as `sdcadm experimental dc-maint`
    if (self.top) {
        self.progress('Warning: `sdcadm experimental dc-maint` is deprecated.' +
            '\n' + common.indent('Please use `sdcadm dc-maint` instead.',
                '         '));
    }

    if (opts.start && opts.stop) {
        cb(new errors.UsageError('cannot use --start and --stop'));
    } else if (opts.start) {
        if (opts.eta && opts.eta <= new Date()) {
            return cb(new errors.UsageError(
                        '--eta must be set to any time in the future'));
        }
        this.sdcadm.dcMaintStart({
            progress: self.progress,
            eta: opts.eta.toISOString(),
            message: opts.message
        }, cb);
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
    }
}
do_dc_maint.options = [
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
do_dc_maint.help = (
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
    'starting that new jobs could come in.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} dc-maint [-j]                                    # show ' +
    'DC maint status\n' +
    '     {{name}} dc-maint --start [--eta ETA] [--message MSG]     # start ' +
    'DC maint\n' +
    '     {{name}} dc-maint --stop                                  # stop ' +
    'DC maint\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_dc_maint: do_dc_maint
};
