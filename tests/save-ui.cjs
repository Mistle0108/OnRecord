const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = await fs.mkdtemp(path.join(root,'work','save-ui-'));
  const env = {...process.env, ONRECORD_TEST_PREFERENCES:path.join(output,'preferences.json'), ONRECORD_TEST_OUTPUT:output};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args:[root],env});
  try {
    const page=await app.firstWindow();
    await page.waitForSelector('body[data-ready="true"]');
    assert.equal(await page.locator('#choose-folder').textContent(),'변경');
    const chosen=path.join(output,'긴 저장 경로 확인','OnRecord');
    await app.evaluate(({dialog,shell},directory)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});
      global.testSaveActions=[];
      shell.openPath=async file=>{global.testSaveActions.push(['play',file]);return '';};
      shell.showItemInFolder=file=>global.testSaveActions.push(['reveal',file]);
    },chosen);
    await page.locator('#choose-folder').click();
    await page.waitForFunction(directory=>document.querySelector('#directory').title===directory,chosen);
    assert.equal(await page.locator('#directory').textContent(),'긴 저장 경로 확인 / OnRecord');
    await page.locator('#delay').selectOption('0');
    await page.locator('#format').selectOption('webm');
    await page.locator('#resolution').selectOption('720');
    await page.locator('#empty-choose').click();
    await page.locator('.source-card').first().click();
    await page.waitForFunction(()=>document.querySelector('#source-video').videoWidth>2);
    const audioSettings=await page.evaluate(()=>document.querySelector('#source-video').srcObject.getAudioTracks()[0].getSettings());
    assert.equal(audioSettings.channelCount,2);
    // A controlled stereo signal verifies the saved sound without relying on other apps playing audio.
    await page.evaluate(async()=>{
      const ctx=new AudioContext({sampleRate:48000}); await ctx.resume();
      const destination=ctx.createMediaStreamDestination(), merger=ctx.createChannelMerger(2);
      for(const [channel,frequency] of [440,997].entries()){
        const oscillator=ctx.createOscillator(),gain=ctx.createGain();
        oscillator.frequency.value=frequency;gain.gain.value=.08;
        oscillator.connect(gain).connect(merger,0,channel);oscillator.start();
      }
      merger.connect(destination);window.testAudioContext=ctx;
      const stream=document.querySelector('#source-video').srcObject;
      for(const track of stream.getAudioTracks()){stream.removeTrack(track);track.stop();}
      destination.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
    });
    const previewBefore=await page.locator('#preview-stage').boundingBox();
    await page.locator('#record').click();
    await page.waitForFunction(()=>document.querySelector('#timer').textContent>='00:00:02');
    assert.equal(await page.locator('#choose-folder').isDisabled(),true);
    assert.equal(await page.locator('#open-directory').isEnabled(),true);
    await page.locator('#open-directory').click();
    await page.waitForFunction(()=>document.querySelector('#record-label').textContent==='녹화 종료');
    assert.deepEqual(await app.evaluate(()=>global.testSaveActions),[['play',chosen]]);
    await app.evaluate(()=>{global.testSaveActions=[];});
    await page.locator('#record').click();
    await page.waitForSelector('#result:not([hidden])');
    await page.waitForFunction(()=>!document.querySelector('#choose-folder').disabled);
    const previewAfter=await page.locator('#preview-stage').boundingBox();
    assert.deepEqual(previewAfter,previewBefore);
    const result=await page.locator('#result').boundingBox();
    assert.ok(result.x>=previewAfter.x && result.y>=previewAfter.y && result.x+result.width<=previewAfter.x+previewAfter.width && result.y+result.height<=previewAfter.y+previewAfter.height);
    const saved=await page.locator('#result-path').getAttribute('title');
    assert.equal(path.dirname(saved),chosen);
    assert.equal(await page.locator('#result-path').textContent(),path.basename(saved));
    assert.ok(saved.endsWith('.webm'));
    const probe=spawnSync(require('ffmpeg-static'),['-hide_banner','-i',saved],{encoding:'utf8',windowsHide:true});
    assert.match(probe.stderr,/Audio: opus, 48000 Hz, stereo/);
    const decoded=spawnSync(require('ffmpeg-static'),['-v','error','-i',saved,'-map','0:a:0','-f','f32le','-c:a','pcm_f32le','pipe:1'],{windowsHide:true,maxBuffer:8*1024*1024});
    assert.equal(decoded.status,0,decoded.stderr.toString());
    assert.ok(decoded.stdout.length>48000*2*4);
    for(let channel=0;channel<2;channel++){
      let sum=0,count=0;
      for(let i=channel*4;i<decoded.stdout.length;i+=8){const sample=decoded.stdout.readFloatLE(i);sum+=sample*sample;count++;}
      assert.ok(Math.sqrt(sum/count)>.02,'Saved WebM must retain audible signal in each channel');
    }
    await page.locator('#play-result').click();
    await page.locator('#reveal-result').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await app.evaluate(()=>global.testSaveActions),[['play',saved],['reveal',saved]]);
    await page.screenshot({path:path.join(output,'saved.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='OnRecord').setSize(880,540));
    await page.waitForFunction(()=>innerWidth===880);
    const small=await page.locator('#preview-stage').boundingBox();
    const smallResult=await page.locator('#result').boundingBox();
    assert.ok(smallResult.x>=small.x && smallResult.x+smallResult.width<=small.x+small.width);
    await page.locator('#close-result').click();
    assert.equal(await page.locator('#result').isVisible(),false);
    assert.deepEqual(await page.locator('#preview-stage').boundingBox(),small);
    console.log(JSON.stringify({passed:true,saved,audio:'Opus stereo 48 kHz; controlled sound decoded in both channels',checks:['separate folder change button and full path tooltip','folder selection saves to chosen directory','preview dimensions unchanged after save and dismiss','notification contained at default and minimum window widths','play and reveal actions target saved file','WebM audio track and decoded signal']},null,2));
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
