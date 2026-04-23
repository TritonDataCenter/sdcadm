/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */
'use strict';

/*
 * The 'sdcadm experimental get-tritonadm' CLI subcommand.
 *
 * Downloads a tritonadm image from the updates channel and executes its
 * self-extracting installer. Short-circuits with "Already up-to-date"
 * when the candidate image UUID matches the uuid recorded in
 * /opt/triton/tritonadm/etc/version (KEY=VALUE format with keys:
 * uuid, version, installed_at, source).
 */

var assert = require('assert-plus');
var child_process = require('child_process');
var exec = child_process.exec;
var format = require('util').format;
var fs = require('fs');
var mkdirp = require('mkdirp');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');


var TRITONADM_VERSION_FILE = '/opt/triton/tritonadm/etc/version';
var INSTALLER_DIR = '/var/tmp';
var WRKDIR_BASE = '/var/sdcadm/tritonadm-installs';


/*
 * Parse the KEY=VALUE format used by /opt/triton/tritonadm/etc/version.
 * Blank lines and lines starting with '#' are ignored. Each remaining
 * line must contain an '='; the key is everything before the first '=',
 * the value everything after (both trimmed).
 */
function parseVersionFile(content) {
    assert.string(content, 'content');
    var result = {};
    var lines = content.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '' || line.charAt(0) === '#') {
            continue;
        }
        var idx = line.indexOf('=');
        if (idx === -1) {
            continue;
        }
        var key = line.slice(0, idx).trim();
        var value = line.slice(idx + 1).trim();
        if (key) {
            result[key] = value;
        }
    }
    return result;
}


/*
 * Read and parse the tritonadm version file. On ENOENT, or when the file
 * has no `uuid=` entry, returns null (no tritonadm currently installed).
 */
function readInstalledVersion(filePath, cb) {
    assert.string(filePath, 'filePath');
    assert.func(cb, 'cb');
    fs.readFile(filePath, 'utf8', function onRead(err, data) {
        if (err) {
            if (err.code === 'ENOENT') {
                cb(null, null);
                return;
            }
            cb(new errors.InternalError({
                message: 'error reading tritonadm version file',
                path: filePath,
                cause: err
            }));
            return;
        }
        var parsed = parseVersionFile(data);
        if (!parsed.uuid) {
            cb(null, null);
            return;
        }
        cb(null, parsed);
    });
}


/*
 * Pick the most recently published candidate. Matches the jq pipeline
 * used by tools/install-tritonadm.sh and tritonadm's own self-update:
 * sort_by(.published_at) | reverse | .[0].
 */
function pickLatest(candidates) {
    assert.arrayOfObject(candidates, 'candidates');
    if (candidates.length === 0) {
        return undefined;
    }
    var sorted = candidates.slice().sort(function (a, b) {
        if (a.published_at < b.published_at) {
            return 1;
        }
        if (a.published_at > b.published_at) {
            return -1;
        }
        return 0;
    });
    return sorted[0];
}


/*
 * GetTritonadm engine. Orchestrates: ensureSdcApp, acquireLock,
 * getDefaultChannel, read installed version, pick candidate by UUID or
 * --latest, short-circuit on UUID match, download, create workdir, exec
 * installer, release lock.
 */
function GetTritonadm(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.image, 'opts.image');
    assert.optionalBool(opts.dryRun, 'opts.dryRun');
    assert.optionalString(opts.versionFile, 'opts.versionFile');
    assert.optionalString(opts.installerDir, 'opts.installerDir');
    assert.optionalString(opts.wrkDirBase, 'opts.wrkDirBase');

    this.sdcadm = opts.sdcadm;
    this.log = opts.sdcadm.log;
    this.progress = opts.progress;
    this.image = opts.image;
    this.dryRun = Boolean(opts.dryRun);
    this.versionFile = opts.versionFile || TRITONADM_VERSION_FILE;
    this.installerDir = opts.installerDir || INSTALLER_DIR;
    this.wrkDirBase = opts.wrkDirBase || WRKDIR_BASE;
}


GetTritonadm.prototype.run = function run(cb) {
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = self.sdcadm;
    var progress = self.progress;
    var log = self.log;

    var dryPrefix = self.dryRun ? '[dry-run] ' : '';
    var unlock;
    var channel;
    var installed;
    var candidate;
    var installerPath;
    var wrkDir;
    var start;

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, next) {
            sdcadm.ensureSdcApp({}, next);
        },

        function getLock(_, next) {
            if (self.dryRun) {
                next();
                return;
            }
            sdcadm.acquireLock({progress: progress},
                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },

        function setStart(_, next) {
            // After the lock, to avoid wrkDir collisions.
            start = new Date();
            next();
        },

        function getChannel(_, next) {
            sdcadm.getDefaultChannel(function (err, ch) {
                channel = ch;
                progress('Using channel %s', channel);
                next(err);
            });
        },

        function getInstalled(_, next) {
            readInstalledVersion(self.versionFile,
                    function (err, vers) {
                if (err) {
                    next(err);
                    return;
                }
                installed = vers;
                if (installed) {
                    progress('Installed tritonadm: uuid=%s version=%s',
                        installed.uuid,
                        installed.version || '<unknown>');
                } else {
                    progress('No tritonadm currently installed');
                }
                next();
            });
        },

        function pickCandidate(_, next) {
            if (self.image === 'latest') {
                var filters = {
                    name: 'tritonadm',
                    state: 'active'
                };
                sdcadm.updates.listImages(filters,
                        function (err, imgs) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'updates'));
                        return;
                    }
                    candidate = pickLatest(imgs);
                    next();
                });
                return;
            }
            sdcadm.updates.getImage(self.image, function (err, img) {
                if (err) {
                    next(new errors.SDCClientError(err, 'updates'));
                    return;
                }
                candidate = img;
                next();
            });
        },

        function checkCandidate(_, next) {
            if (!candidate) {
                progress('No tritonadm images available (using "%s" ' +
                    'update channel).', channel);
                next();
                return;
            }
            if (installed && installed.uuid === candidate.uuid) {
                progress('Already up-to-date (using "%s" update channel).',
                    channel);
                candidate = null;
                next();
                return;
            }
            progress('%sInstall tritonadm %s (%s)', dryPrefix,
                candidate.version,
                candidate.uuid);
            next();
        },

        function downloadInstaller(_, next) {
            if (!candidate || self.dryRun) {
                next();
                return;
            }
            progress('%sDownload tritonadm image from %s', dryPrefix,
                sdcadm.config.updatesServerUrl);
            installerPath = self.installerDir + '/tritonadm-' +
                candidate.uuid;
            sdcadm.updates.getImageFile(candidate.uuid, installerPath,
                    function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error downloading tritonadm image',
                        updatesServerUrl: sdcadm.config.updatesServerUrl,
                        uuid: candidate.uuid,
                        cause: err
                    }));
                    return;
                }
                fs.chmod(installerPath, 0o755, function (chmodErr) {
                    if (chmodErr) {
                        next(new errors.InternalError({
                            message: 'error chmoding tritonadm installer',
                            path: installerPath,
                            cause: chmodErr
                        }));
                        return;
                    }
                    next();
                });
            });
        },

        function createWrkDir(_, next) {
            if (!candidate || self.dryRun) {
                next();
                return;
            }
            var stamp = common.utcTimestamp(start);
            wrkDir = self.wrkDirBase + '/' + stamp;
            mkdirp(wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function runInstaller(_, next) {
            if (!candidate) {
                next();
                return;
            }
            progress('%sRun tritonadm installer (log at %s/install.log)',
                dryPrefix, wrkDir || '<dry-run>');
            if (self.dryRun) {
                next();
                return;
            }
            var cmd = format('%s >%s/install.log 2>&1', installerPath,
                wrkDir);
            var env = common.objCopy(process.env);
            env.TRACE = '1';
            var execOpts = {env: env};
            log.trace({cmd: cmd}, 'run tritonadm installer');
            exec(cmd, execOpts, function (err, stdout, stderr) {
                log.trace({cmd: cmd, err: err, stdout: stdout,
                    stderr: stderr}, 'ran tritonadm installer');
                if (err) {
                    next(new errors.InternalError({
                        message: 'error running tritonadm installer',
                        cmd: cmd,
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (self.dryRun || !unlock) {
                    next();
                    return;
                }
                sdcadm.releaseLock({unlock: unlock}, next);
            },
            function noteCompletion(_, next) {
                if (!candidate || err) {
                    next();
                    return;
                }
                progress('%sInstalled tritonadm %s (%s, elapsed %ss)',
                    dryPrefix, candidate.version, candidate.uuid,
                    Math.floor((Date.now() - start) / 1000));
                next();
            }
        ]}, function done(finishErr) {
            if (finishErr) {
                log.fatal({err: finishErr},
                    'unexpected error finishing get-tritonadm');
            }
            cb(err || finishErr);
        });
    });
};


/**
 * Download and install tritonadm from the updates channel.
 * @this Cmdln
 */
function do_get_tritonadm(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
        return;
    }

    var image = opts.latest ? 'latest' : args.shift();
    if (!image) {
        cb(new errors.UsageError(
            'Please provide an image UUID or use ' +
            '`sdcadm experimental get-tritonadm --latest`\n' +
            'in order to install the latest available image.'));
        return;
    }
    if (image === 'help') {
        cb(new errors.UsageError(
            'Please use `sdcadm experimental help get-tritonadm` instead'));
        return;
    }

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function setServer(_, next) {
            if (opts.source) {
                self.sdcadm.config.updatesServerUrl = opts.source;
            }
            next();
        },
        function setChannel(_, next) {
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }
            next();
        },
        function runEngine(_, next) {
            var engine = new GetTritonadm({
                sdcadm: self.sdcadm,
                progress: self.progress,
                image: image,
                dryRun: opts.dry_run
            });
            engine.run(next);
        }
    ]}, cb);
}


do_get_tritonadm.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually installing.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image, even if it is ' +
            'not the default one.'
    },
    {
        names: ['source', 'S'],
        type: 'string',
        help: 'An image source (url) from which to import.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Get the latest available image.'
    }
];


do_get_tritonadm.help = (
    'Download and install tritonadm from the updates channel.\n' +
    '\n' +
    'This is an experimental command. It fetches a tritonadm image\n' +
    'and executes its self-extracting installer. When the candidate\n' +
    'image UUID matches the uuid recorded in\n' +
    '/opt/triton/tritonadm/etc/version, the command short-circuits\n' +
    'with "Already up-to-date".\n' +
    '\n' +
    'Usage:\n' +
    '     # Install the given image UUID:\n' +
    '     {{name}} get-tritonadm IMAGE_UUID [<options>]\n' +
    '     # Install the latest available image:\n' +
    '     {{name}} get-tritonadm --latest [<options>]\n' +
    '     # Install from a specific imgapi server:\n' +
    '     {{name}} get-tritonadm -S http://imgapi.example.com IMAGE_UUID\n' +
    '\n' +
    '{{options}}'
);

do_get_tritonadm.logToFile = true;


// --- exports

module.exports = {
    do_get_tritonadm: do_get_tritonadm,
    _GetTritonadm: GetTritonadm,
    _parseVersionFile: parseVersionFile,
    _readInstalledVersion: readInstalledVersion,
    _pickLatest: pickLatest,
    _TRITONADM_VERSION_FILE: TRITONADM_VERSION_FILE
};
