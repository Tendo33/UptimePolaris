import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicSubscriptionAddress,validateSubscriptionDestination} from '../../backends/worker/src/lib/subscriptions/egress';
import {fetchSubscriptionResponses} from '../../shared/subscription-fetch';
import {JSON_SUBSCRIPTION} from '../../shared/subscription-templates';

test('private, reserved and mapped DNS answers are refused',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','198.18.0.1','100.64.0.1','192.0.2.2','::1','::ffff:7f00:1','fc00::1','fe80::1','2001:db8::1',['2001','2','','1'].join(':'),['2002','7f00','1','','1'].join(':')]) assert.equal(publicSubscriptionAddress(address),false,address);
 assert.equal(publicSubscriptionAddress([1,1,1,1].join('.')),true);
 assert.equal(publicSubscriptionAddress('2606:4700:4700::1111'),true);
 await assert.rejects(validateSubscriptionDestination(new URL('https://private.service.net'),undefined,async()=>Response.json({Status:0,Answer:[{type:1,data:'127.0.0.1'}]})),{code:'subscription_source_blocked'});
});
test('DNS changes on a redirect are rechecked before the second source request',async()=>{
 let lookups=0,sourceReads=0;
 const dns:typeof fetch=async()=>Response.json({Status:0,Answer:[{type:1,data:++lookups<=2?[1,1,1,1].join('.'):'10.0.0.1'}]});
 const result=await fetchSubscriptionResponses(JSON_SUBSCRIPTION,{baseUrl:'https://status.service.net'},{validateUrl:url=>validateSubscriptionDestination(url,undefined,dns),fetch:async()=>{sourceReads++;return new Response(null,{status:302,headers:{location:'/next'}})}},Math.floor(Date.now()/1000));
 assert.equal(sourceReads,1);assert.equal(result.failures[0].code,'subscription_source_blocked');
});
