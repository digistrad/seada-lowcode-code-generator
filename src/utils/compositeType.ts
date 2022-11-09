import {
  CompositeArray,
  CompositeValue,
  CompositeObject,
  JSFunction,
  JSExpression,
  isJSExpression,
  isJSFunction,
  isJSSlot,
  JSSlot,
} from '@alilc/lowcode-types';
import _ from 'lodash';

import { IScope, CompositeValueGeneratorOptions, CodeGeneratorError } from '../types';
import { generateExpression, generateFunction } from './jsExpression';
import { generateJsSlot } from './jsSlot';
import { executeFunctionStack } from './aopHelper';
import { parseExpressionGetKeywords } from './expressionParser';

interface ILegaoVariable {
  type: 'variable';
  value: string;
  variable: string;
}

function isVariable(v: any): v is ILegaoVariable {
  if (_.isObject(v) && (v as ILegaoVariable).type === 'variable') {
    return true;
  }
  return false;
}

interface DataSource {
  type: 'DataSource';
  id: string;
}

/**
 * 判断是否是数据源类型
 */
function isDataSource(v: unknown): v is DataSource {
  return typeof v === 'object' && v != null && (v as Partial<DataSource>).type === 'DataSource';
}

function generateArray(
  value: CompositeArray,
  scope: IScope,
  options: CompositeValueGeneratorOptions = {},
): string {
  const body = value.map((v) => generateUnknownType(v, scope, options)).join(',');
  return `[${body}]`;
}

function generateObject(
  value: CompositeObject,
  scope: IScope,
  options: CompositeValueGeneratorOptions = {},
): string {
  if (value.type === 'i18n') {
    // params 可能会绑定变量，这里需要处理下
    if (value.params && typeof value.params === 'object') {
      return `this._i18nText(${generateUnknownType(_.omit(value, 'type'), scope, options)})`;
    }
    return `this._i18nText(${JSON.stringify(_.omit(value, 'type'))})`; // TODO: 优化：这里可以考虑提取成个常量...
  }

  const body = Object.keys(value)
    .map((key) => {
      const propName = JSON.stringify(key);
      const v = generateUnknownType(value[key], scope, options);
      return `${propName}: ${v}`;
    })
    .join(',\n');

  return `{${body}}`;
}

function generateString(value: string): string {
  // 有的字符串里面会有特殊字符，比如换行或引号之类的，这里我们借助 JSON 的字符串转义功能来做下转义并加上双引号
  return JSON.stringify(value);
}

function generateNumber(value: number): string {
  return String(value);
}

function generateBool(value: boolean): string {
  return value ? 'true' : 'false';
}

/**
 * 生成function
 * @param value JSFunction
 * @returns 生成的function字符串
 */
function genFunction(value: JSFunction): string {
  const funcValue = value.value.replace(/[\r\t\n]/g, ''); // 去掉一些特殊字符，避免影响正则匹配
  if (
    funcValue.startsWith('function()') &&
    funcValue.indexOf('.apply(this,Array.prototype.slice.call(arguments).concat([') !== -1
  ) {
    // 判断为方法属性，另外处理
    // 获取方法名
    const funcName = funcValue.split('.')[1];
    // 获取中括号内的参数
    const regex = /\[(.+?)\]/g;
    const matchArr = funcValue.match(regex);

    if (!matchArr) {
      // 没有额外传入的参数
      return generateFunction({
        type: 'JSFunction',
        value: `(...args) => { ${funcName}(...args); }`,
      });
    }
    // 有额外传入的参数
    return generateFunction({
      type: 'JSFunction',
      value: `(...args) => { ${funcName}(...args, ${matchArr[0].slice(1, -1)}); }`,
    });
  }
  const globalVars = parseExpressionGetKeywords(funcValue);
  // 如果含有arguments关键字，绑定this
  if (globalVars.includes('arguments')) {
    return generateFunction(value, { isBindExpr: true });
  }

  return generateFunction(value, { isArrow: true });
}

function genJsSlot(value: JSSlot, scope: IScope, options: CompositeValueGeneratorOptions = {}) {
  if (options.nodeGenerator) {
    return generateJsSlot(value, scope, options.nodeGenerator);
  }
  return '';
}

function generateUnknownType(
  value: CompositeValue,
  scope: IScope,
  options: CompositeValueGeneratorOptions = {},
): string {
  // 如果是undefined，直接返回undefined字符串
  if (_.isUndefined(value)) {
    return 'undefined';
  }
  // 如果是null，直接返回null字符串
  if (_.isNull(value)) {
    return 'null';
  }
  // 如果是数组，应该是对每个值都使用generateUnknownType处理一遍，获取到的结果放到[]里面
  if (_.isArray(value)) {
    if (options.handlers?.array) {
      return executeFunctionStack(value, scope, options.handlers.array, generateArray, options);
    }
    return generateArray(value, scope, options);
  }

  // FIXME: 这个是临时方案
  // 在遇到 type variable 私有类型时，转换为 JSExpression
  if (isVariable(value)) {
    const transValue: JSExpression = {
      type: 'JSExpression',
      value: value.variable,
    };

    if (options.handlers?.expression) {
      return executeFunctionStack(
        transValue,
        scope,
        options.handlers.expression,
        generateExpression,
        options,
      );
    }
    return generateExpression(transValue, scope);
  }

  if (isJSExpression(value)) {
    if (options.handlers?.expression) {
      return executeFunctionStack(
        value,
        scope,
        options.handlers.expression,
        generateExpression,
        options,
      );
    }
    return generateExpression(value, scope);
  }

  if (isJSFunction(value)) {
    if (options.handlers?.function) {
      return executeFunctionStack(value, scope, options.handlers.function, genFunction, options);
    }
    return genFunction(value);
  }

  if (isJSSlot(value)) {
    if (options.handlers?.slot) {
      return executeFunctionStack(value, scope, options.handlers.slot, genJsSlot, options);
    }
    return genJsSlot(value, scope, options);
  }

  if (isDataSource(value)) {
    return generateUnknownType(
      {
        type: 'JSExpression',
        value: `this.dataSourceMap[${JSON.stringify(value.id)}]`,
      },
      scope,
      options,
    );
  }

  if (_.isObject(value)) {
    if (options.handlers?.object) {
      return executeFunctionStack(value, scope, options.handlers.object, generateObject, options);
    }
    return generateObject(value as CompositeObject, scope, options);
  }

  if (_.isString(value)) {
    if (options.handlers?.string) {
      return executeFunctionStack(value, scope, options.handlers.string, generateString, options);
    }
    return generateString(value);
  }

  if (_.isNumber(value)) {
    if (options.handlers?.number) {
      return executeFunctionStack(value, scope, options.handlers.number, generateNumber, options);
    }
    return generateNumber(value);
  }

  if (_.isBoolean(value)) {
    if (options.handlers?.boolean) {
      return executeFunctionStack(value, scope, options.handlers.boolean, generateBool, options);
    }
    return generateBool(value);
  }

  throw new CodeGeneratorError('Meet unknown composite value type');
}

// 这一层曾经是对产出做最外层包装的，但其实包装逻辑不应该属于这一层
// 这一层先不去掉，做冗余，方便后续重构
/**
 * 将各种类型的值转换为字符型的代码，这里就是套一个壳，好像没什么用，真正是使用generateUnknownType这个方法
 * @param value
 * @param scope
 * @param options
 * @returns 返回转换后的代码字符串
 */
export function generateCompositeType(
  value: CompositeValue,
  scope: IScope,
  options: CompositeValueGeneratorOptions = {},
): string {
  const result = generateUnknownType(value, scope, options);
  return result;
}
