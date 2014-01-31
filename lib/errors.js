/**
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Error classes that mill/milld may produce.
 */

var util = require('util'),
    format = util.format;
var assert = require('assert-plus');
var verror = require('verror'),
    WError = verror.WError,
    VError = verror.VError;



// ---- internal support stuff

function _indent(s, indent) {
    if (!indent) indent = '    ';
    var lines = s.split(/\r?\n/g);
    return indent + lines.join('\n' + indent);
}



// ---- error classes

/**
 * Base mill error. Instances will always have a string `message` and
 * a string `code` (a CamelCase string).
 */
function MillError(options) {
    assert.object(options, 'options');
    assert.string(options.message, 'options.message');
    assert.string(options.code, 'options.code');
    assert.optionalObject(options.cause, 'options.cause');
    assert.optionalNumber(options.statusCode, 'options.statusCode');
    var self = this;

    var args = [];
    if (options.cause) args.push(options.cause);
    args.push(options.message);
    WError.apply(this, args);

    var extra = Object.keys(options).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = options[k];
    });
}
util.inherits(MillError, VError);

function InternalError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    MillError.call(this, {
        cause: cause,
        message: message,
        code: 'InternalError',
        exitStatus: 1
    });
}
util.inherits(InternalError, MillError);

function UsageError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    MillError.call(this, {
        cause: cause,
        message: message,
        code: 'Usage',
        exitStatus: 1
    });
}
util.inherits(UsageError, MillError);


/**
 * Multiple errors in a group.
 */
function MultiError(errs) {
    assert.arrayOfObject(errs, 'errs');
    var lines = [format('multiple (%d) errors', errs.length)];
    for (var i = 0; i < errs.length; i++) {
        var err = errs[i];
        lines.push(format('    error (%s): %s', err.code, err.message));
    }
    MillError.call(this, {
        cause: errs[0],
        message: lines.join('\n'),
        code: 'MultiError',
        exitStatus: 1
    });
}
MultiError.description = 'Multiple errors.';
util.inherits(MultiError, MillError);



// ---- exports

module.exports = {
    MillError: MillError,
    InternalError: InternalError,
    UsageError: UsageError,
    MultiError: MultiError
};
// vim: set softtabstop=4 shiftwidth=4:
