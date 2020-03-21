import Displayable, { DisplayableProps,
    CommonStyleProps,
    DEFAULT_COMMON_STYLE,
    DisplayableStatePropNames
} from './Displayable';
import Element from '../Element';
import PathProxy from '../core/PathProxy';
import * as pathContain from '../contain/path';
import { PatternObject } from './Pattern';
import { Dictionary, PropType } from '../core/types';
import BoundingRect from '../core/BoundingRect';
import { LinearGradientObject } from './LinearGradient';
import { RadialGradientObject } from './RadialGradient';
import { defaults, keys, extend, clone } from '../core/util';
import Animator from '../animation/Animator';

export interface PathStyleProps extends CommonStyleProps {
    fill?: string | PatternObject | LinearGradientObject | RadialGradientObject
    stroke?: string | PatternObject | LinearGradientObject | RadialGradientObject
    strokeNoScale?: boolean
    fillOpacity?: number
    strokeOpacity?: number

    /**
     * `true` is not supported.
     * `false`/`null`/`undefined` are the same.
     * `false` is used to remove lineDash in some
     * case that `null`/`undefined` can not be set.
     * (e.g., emphasis.lineStyle in echarts)
     */
    lineDash?: false | number[]
    lineDashOffset?: number

    lineWidth?: number
    lineCap?: CanvasLineCap
    lineJoin?: CanvasLineJoin

    miterLimit?: number
    /**
     * Paint order, if do stroke first. Similar to SVG paint-order
     * https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/paint-order
     */
    strokeFirst?: boolean
}

export const DEFAULT_PATH_STYLE: PathStyleProps = defaults({
    fill: '#000',
    stroke: null,
    lineDashOffset: 0,
    lineWidth: 1,
    lineCap: 'butt',
    miterLimit: 10,

    strokeNoScale: false,
    strokeFirst: false
}, DEFAULT_COMMON_STYLE);

export interface PathProps extends DisplayableProps {
    strokeContainThreshold?: number
    segmentIgnoreThreshold?: number
    subPixelOptimize?: boolean

    style?: PathStyleProps
    shape?: Dictionary<any>

    buildPath?: (
        ctx: PathProxy | CanvasRenderingContext2D,
        shapeCfg: Dictionary<any>,
        inBundle?: boolean
    ) => void
}


type PathKey = keyof PathProps
type PathPropertyType = PropType<PathProps, PathKey>

interface Path<Props extends PathProps = PathProps> {
    animate(key?: '', loop?: boolean): Animator<this>
    animate(key: 'style', loop?: boolean): Animator<this['style']>
    animate(key: 'shape', loop?: boolean): Animator<this['shape']>
}

export type PathStatePropNames = DisplayableStatePropNames | 'shape';

class Path<Props extends PathProps = PathProps> extends Displayable<Props> {

    path: PathProxy

    strokeContainThreshold: number

    // This item default to be false. But in map series in echarts,
    // in order to improve performance, it should be set to true,
    // so the shorty segment won't draw.
    segmentIgnoreThreshold: number

    subPixelOptimize: boolean

    style: PathStyleProps

    __dirtyPath: boolean
    __clipTarget: Element

    private _rectWithStroke: BoundingRect

    // override
    states: Dictionary<Pick<PathProps, PathStatePropNames>>

    // Must have an initial value on shape.
    // It will be assigned by default value.
    shape: Dictionary<any>

    constructor(opts?: Props) {
        super(opts);
    }

    protected _init(props?: Props) {
        // Init default properties
        const keysArr = keys(props);
        this.shape = this.getDefaultShape();
        for (let i = 0; i < keysArr.length; i++) {
            const key = keysArr[i];
            if (key === 'style') {
                this.useStyle(props[key]);
            }
            else if (key === 'shape') {
                // this.shape = props[key];
                extend(this.shape, props[key]);
            }
            else {
                super.attrKV(key as any, props[key]);
            }
        }
        const defaultStyle = this.getDefaultStyle();
        // Give a empty style
        if (!this.style) {
            this.useStyle(defaultStyle || {});
        }
        else if (defaultStyle) {
            defaults(this.style, defaultStyle);
        }

        // const defaultShape = this.getDefaultShape();
        // if (!this.shape) {
        //     this.shape = defaultShape;
        // }
        // else {
        //     defaults(this.shape, defaultShape);
        // }
    }

    protected getDefaultStyle(): Props['style'] {
        return null;
    }

    // Needs to override
    protected getDefaultShape() {
        return {};
    }

    // When bundling path, some shape may decide if use moveTo to begin a new subpath or closePath
    // Like in circle
    buildPath(
        ctx: PathProxy | CanvasRenderingContext2D,
        shapeCfg: Dictionary<any>,
        inBundle?: boolean
    ) {}

    createPathProxy() {
        this.path = new PathProxy();
    }

    hasStroke() {
        const style = this.style;
        const stroke = 'stroke' in style ? style.stroke : DEFAULT_PATH_STYLE.stroke;
        return stroke != null && stroke !== 'none' && style.lineWidth > 0;
    }

    hasFill() {
        const style = this.style;
        const fill = 'fill' in style ? style.fill : DEFAULT_PATH_STYLE.fill;
        return fill != null && fill !== 'none';
    }

    getBoundingRect(): BoundingRect {
        let rect = this._rect;
        const style = this.style;
        const needsUpdateRect = !rect;
        if (needsUpdateRect) {
            let path = this.path;
            if (!path) {
                // Create path on demand.
                path = this.path = new PathProxy();
            }
            if (this.__dirtyPath) {
                path.beginPath();
                this.buildPath(path, this.shape, false);
            }
            rect = path.getBoundingRect();
        }
        this._rect = rect;

        if (this.hasStroke()) {
            // Needs update rect with stroke lineWidth when
            // 1. Element changes scale or lineWidth
            // 2. Shape is changed
            const rectWithStroke = this._rectWithStroke || (this._rectWithStroke = rect.clone());
            if (this.__dirty || needsUpdateRect) {
                rectWithStroke.copy(rect);
                // PENDING, Min line width is needed when line is horizontal or vertical
                const lineScale = style.strokeNoScale ? this.getLineScale() : 1;
                // FIXME Must after updateTransform
                let w = style.lineWidth;

                // Only add extra hover lineWidth when there are no fill
                if (!this.hasFill()) {
                    w = Math.max(w, this.strokeContainThreshold || 4);
                }
                // Consider line width
                // Line scale can't be 0;
                if (lineScale > 1e-10) {
                    rectWithStroke.width += w / lineScale;
                    rectWithStroke.height += w / lineScale;
                    rectWithStroke.x -= w / lineScale / 2;
                    rectWithStroke.y -= w / lineScale / 2;
                }
            }

            // Return rect with stroke
            return rectWithStroke;
        }

        return rect;
    }

    contain(x: number, y: number): boolean {
        const localPos = this.transformCoordToLocal(x, y);
        const rect = this.getBoundingRect();
        const style = this.style;
        x = localPos[0];
        y = localPos[1];

        if (rect.contain(x, y)) {
            const pathData = this.path.data;
            if (this.hasStroke()) {
                let lineWidth = style.lineWidth;
                let lineScale = style.strokeNoScale ? this.getLineScale() : 1;
                // Line scale can't be 0;
                if (lineScale > 1e-10) {
                    // Only add extra hover lineWidth when there are no fill
                    if (!this.hasFill()) {
                        lineWidth = Math.max(lineWidth, this.strokeContainThreshold);
                    }
                    if (pathContain.containStroke(
                        pathData, lineWidth / lineScale, x, y
                    )) {
                        return true;
                    }
                }
            }
            if (this.hasFill()) {
                return pathContain.contain(pathData, x, y);
            }
        }
        return false;
    }

    dirty() {
        super.dirty();
        // Used as a clipping path
        if (this.__clipTarget) {
            this.__clipTarget.dirty();
        }
    }

    /**
     * Shape changed
     */
    dirtyShape() {
        this.__dirtyPath = true;
        this.dirty();
    }

    /**
     * Alias for animate('shape')
     * @param {boolean} loop
     */
    animateShape(loop: boolean) {
        return this.animate('shape', loop);
    }

    // Override updateDuringAnimation
    updateDuringAnimation(targetKey: string) {
        if (targetKey === 'style') {
            this.dirtyStyle();
        }
        else if (targetKey === 'shape') {
            this.dirtyShape();
        }
        else {
            this.dirty();
        }
    }

    // Overwrite attrKV
    attrKV(key: PathKey, value: PathPropertyType) {
        // FIXME
        if (key === 'shape') {
            this.setShape(value as Props['shape']);
            this.__dirtyPath = true;
            this._rect = null;
        }
        else {
            super.attrKV(key as keyof DisplayableProps, value);
        }
    }

    setShape(obj: Props['shape']): void
    setShape<T extends keyof Props['shape']>(obj: T, value: Props['shape'][T]): void
    setShape(keyOrObj: keyof Props['shape'] | Props['shape'], value?: unknown) {
        let shape = this.shape;
        if (!shape) {
            shape = this.shape = {};
        }
        // Path from string may not have shape
        if (typeof keyOrObj === 'string') {
            shape[keyOrObj] = value;
        }
        else {
            extend(shape, keyOrObj as Props['shape']);
        }
        this.dirtyShape();

        return this;
    }

    /**
     * Replace the style with given new style object.
     */
    useStyle(obj: PathStyleProps, inherited?: PathStyleProps) {
        super.useStyle(obj, inherited || DEFAULT_PATH_STYLE);
    }


    protected saveStateToNormal() {
        super.saveStateToNormal();

        this.states.normal.shape = this.shape;
    }

    useState(stateName: string) {
        let state = super.useState(stateName) as Path['states'][string];
        if (state && state.shape) {
            // Inherits shape from normal state first.
            // TODO performance?
            this.shape = extend({}, this.states.normal.shape);
            extend(this.shape, state.shape);

            this.dirtyShape();''
        }
        return state;
    }

    /**
     * If path shape is zero area
     */
    isZeroArea(): boolean {
        return false;
    }
    /**
     * 扩展一个 Path element, 比如星形，圆等。
     * Extend a path element
     * @DEPRECATED Use class extends
     * @param props
     * @param props.type Path type
     * @param props.init Initialize
     * @param props.buildPath Overwrite buildPath method
     * @param props.style Extended default style config
     * @param props.shape Extended default shape config
     */
    static extend<Shape extends Dictionary<any>>(defaultProps: {
        type?: string
        shape?: Shape
        style?: PathStyleProps
        beforeBrush?: Displayable['beforeBrush']
        afterBrush?: Displayable['afterBrush']
        getBoundingRect?: Displayable['getBoundingRect']

        buildPath(this: Path, ctx: CanvasRenderingContext2D | PathProxy, shape: Shape, inBundle?: boolean): void
        init?(this: Path, opts: PathProps): void // TODO Should be SubPathOption
    }): {
        new(opts?: PathProps & {shape: Shape}): Path
    } {

        const defaultShape = clone(defaultProps.shape);
        const defaultStyle = clone(defaultProps.style);
        interface SubPathOption extends PathProps {
            shape: Shape
        }

        class Sub extends Path {

            shape: Shape

            getDefaultStyle() {
                return defaultStyle;
            }

            getDefaultShape() {
                return defaultShape;
            }

            constructor(opts?: SubPathOption) {
                super(opts);
                defaultProps.init && defaultProps.init.call(this as any, opts);
            }
        }

        // TODO Legacy usage. Extend functions
        for (let key in defaultProps) {
            if (typeof (defaultProps as any)[key] === 'function') {
                (Sub.prototype as any)[key] = (defaultProps as any)[key];
            }
        }
        // Sub.prototype.buildPath = defaultProps.buildPath;
        // Sub.prototype.beforeBrush = defaultProps.beforeBrush;
        // Sub.prototype.afterBrush = defaultProps.afterBrush;

        return Sub as any;
    }

    protected static initDefaultProps = (function () {
        const pathProto = Path.prototype;
        pathProto.type = 'path';
        pathProto.strokeContainThreshold = 5;
        pathProto.segmentIgnoreThreshold = 0;
        pathProto.subPixelOptimize = false;
        pathProto.__dirtyPath = true;
    })()
}

export default Path;