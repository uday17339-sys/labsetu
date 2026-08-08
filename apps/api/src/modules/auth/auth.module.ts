import { Module, Global } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { CONFIG, type AppConfig } from '../../config/configuration';

/** The shape jsonwebtoken expects for a duration string, e.g. "15m". */
type jwtExpiry = `${number}${'s' | 'm' | 'h' | 'd'}`;

/**
 * Global because JwtService is needed by JwtAuthGuard, which is registered
 * app-wide, and AuthService.consumeSigningToken is called by every module that
 * applies an electronic signature.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig): JwtModuleOptions => ({
        secret: config.JWT_SECRET,
        signOptions: {
          // jsonwebtoken types expiresIn as a `${number}${unit}` template
          // literal; ours comes from env as a plain string, so it is validated
          // by the config schema and asserted here rather than widened.
          expiresIn: config.JWT_ACCESS_TTL as jwtExpiry,
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
        },
        verifyOptions: {
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
