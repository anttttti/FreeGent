import {afterAll,it,expect} from 'vitest';
import {isCustomEndpoint} from '../../payload-builder.ts';
const W=window as any,observations:any[]=[];
it.each(['custom','vllm'])('%s without an image-capable model does not select a catalog cloud fallback',provider=>{
 localStorage.clear();const model='own-text-only-'+provider,spec=provider+'|'+model;localStorage.setItem('fg_custom_models',JSON.stringify([{provider,model,media:['text'],contextK:128,tools:true,url:'http://own-fixture.invalid/v1',key:'own-synthetic-key'}]));localStorage.setItem('fg_main_models',JSON.stringify([spec]));expect(W.getActiveMainModelList()).toEqual([spec]);expect(W.getProvider()).toBe(provider);
 const endpoint=W.specToEndpoint(spec),selected=W.getMediaCapableSpec(['image']);observations.push({provider,spec,endpoint,isCustom:isCustomEndpoint(endpoint),selected,selectedEndpoint:selected?W.specToEndpoint(selected):null});expect(isCustomEndpoint(endpoint)).toBe(true);expect(selected).toBeNull();
});
